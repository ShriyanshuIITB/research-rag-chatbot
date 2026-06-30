import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { paperId } = req.body;
    if (!paperId) return res.status(400).json({ error: 'Paper ID required' });

    const { data: paper } = await supabase
      .from('papers')
      .select('title, description, full_text, summary, professor_name, institution')
      .eq('id', paperId)
      .single();

    if (!paper) return res.status(404).json({ error: 'Paper not found' });

    let context = paper.full_text || '';
    if (context.length > 12000) context = context.slice(0, 12000);

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 3500,
        temperature: 0.1,
        messages: [
          {
            role: 'system',
            content: `You are a research analyst. Generate a comprehensive report based on the paper content.

**IMPORTANT**: You must output a valid JSON object at the very end of your response with the key "chart_data". The chart_data must be an object with "labels" (array of strings) and "values" (array of numbers) for the key findings that can be plotted as a bar chart. If the paper has no clear numerical data, set "chart_data" to null.

The report must include:
1. Executive Summary
2. Key Findings (with numbers)
3. Methodology
4. Data Highlights (use markdown tables)
5. Policy Implications
6. Limitations
7. Conclusion

Format the main report with clear headings (##) and markdown tables. At the very end, add a JSON block like this:

\`\`\`json
{
  "chart_data": {
    "labels": ["Finding A", "Finding B"],
    "values": [12.5, 8.3]
  }
}
\`\`\`
If no chart data is found, output:
\`\`\`json
{
  "chart_data": null
}
\`\`\``
          },
          {
            role: 'user',
            content: `Paper Title: ${paper.title}\n\n${paper.summary ? 'Summary: ' + paper.summary + '\n\n' : ''}Paper Content:\n${context}`
          }
        ]
      })
    });

    const groqData = await groqRes.json();
    if (!groqRes.ok) throw new Error(groqData.error?.message || 'Groq error');

    let report = groqData.choices?.[0]?.message?.content || 'Could not generate report.';
    let chartData = null;
    try {
      const jsonMatch = report.match(/\{[\s\S]*"chart_data"[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        chartData = parsed.chart_data;
      }
    } catch (e) {
      console.error('Chart data parsing error:', e);
    }

    return res.status(200).json({ report, chartData });

  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Report generation failed', detail: err.message });
  }
}
