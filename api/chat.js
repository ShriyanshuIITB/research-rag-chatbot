import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function getEmbedding(text) {
  const res = await fetch('https://api.jina.ai/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.JINA_API_KEY}`,
    },
    body: JSON.stringify({ input: [text], model: 'jina-embeddings-v2-base-en' }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}

async function rewriteQuery(userMessage, history) {
  if (history.length === 0) return userMessage;
  const hist = history.slice(-6).map(m => `${m.role}: ${m.content}`).join('\n');
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 150,
      temperature: 0.1,
      messages: [
        { role: 'system', content: 'Rewrite the latest user question into a self‑contained question that includes all conversation context. Return only the rewritten question.' },
        { role: 'user', content: `History:\n${hist}\nLatest: "${userMessage}"\nRewritten:` },
      ],
    }),
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || userMessage;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, paperId, conversationHistory = [], crossPaper = false } = req.body;

    const { data: paper, error: paperError } = await supabase
      .from('papers')
      .select('title, description, full_text, professor_id, professor_name, institution')
      .eq('id', paperId)
      .single();

    if (paperError) return res.status(404).json({ error: 'Paper not found' });

    const paperTopic = paper?.title || 'this paper';
    const professorId = paper.professor_id;

    const contextualQuery = await rewriteQuery(message, conversationHistory);
    const embedding = await getEmbedding(contextualQuery);

    let chunks = [];
    let context = '';

    if (crossPaper) {
      const { data: multiChunks, error: multiError } = await supabase.rpc('match_chunks_by_professor', {
        query_embedding: embedding,
        match_professor_id: professorId,
        match_count: 15,
      });

      if (!multiError && multiChunks && multiChunks.length > 0) {
        const grouped = {};
        multiChunks.forEach(c => {
          if (!grouped[c.paper_id]) grouped[c.paper_id] = [];
          grouped[c.paper_id].push(c.content);
        });
        context = Object.entries(grouped).map(([pid, contents]) => {
          const title = multiChunks.find(c => c.paper_id === pid)?.paper_title || 'Another paper';
          return `[From paper: ${title}]\n${contents.join('\n\n')}`;
        }).join('\n\n---\n\n');
        chunks = multiChunks;
      } else {
        if (paper.full_text) context = paper.full_text.slice(0, 8000);
      }
    } else {
      try {
        const { data, error } = await supabase.rpc('match_chunks_with_score', {
          query_embedding: embedding,
          match_paper_id: paperId,
          match_count: 10,
        });
        if (!error && data) chunks = data;
      } catch (e) { console.error('Retrieval error:', e); }

      if (chunks.length > 0) {
        context = chunks.map((c, i) => `[Excerpt ${i+1}]\n${c.content}`).join('\n\n---\n\n');
      } else if (paper.full_text) {
        context = paper.full_text.slice(0, 8000);
      } else {
        await supabase.from('question_logs').insert({
          paper_id: paperId,
          question: message,
          answered: false,
          confidence: 0.0,
        }).catch(() => {});
        return res.status(200).json({ reply: 'I could not find relevant information in this paper to answer your question. Please try rephrasing.' });
      }
    }

    const contextWordCount = context.split(' ').length;
    const isLowConfidence = contextWordCount < 50 || chunks.length < 2;

    const historyForLLM = conversationHistory.slice(-10);

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2500,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: `You are a policy advisor using research papers. The primary paper is "${paperTopic}". 
${crossPaper ? 'You may also use insights from other papers by the same professor.' : ''}

You are given excerpts (or full text) as CONTEXT.  
Answer the user's question **by reasoning from the provided context**.
- If the question asks for a decision, use the paper's frameworks (cost‑benefit, elasticity, etc.) to give a reasoned recommendation.
- If the paper doesn't explicitly mention the user's scenario, **extrapolate** using the paper's logic and formulas.
- Always cite specific numbers, equations, or conclusions from the context.
- If you cannot answer even after reasoning, explain what additional information would be needed.

CONTEXT:
${context}`
          },
          ...historyForLLM,
          { role: 'user', content: message }
        ]
      })
    });

    const groqData = await groqRes.json();
    if (!groqRes.ok) throw new Error(groqData.error?.message || 'Groq error');

    const reply = groqData.choices?.[0]?.message?.content || 'No response.';

    let confidence = 0.9;
    if (reply.includes('could not find') || reply.includes('outside the scope') || reply.includes('not available')) {
      confidence = 0.2;
    } else if (isLowConfidence || reply.length < 50) {
      confidence = 0.5;
    }

    await supabase.from('question_logs').insert({
      paper_id: paperId,
      question: message,
      answered: true,
      confidence: confidence,
    }).catch(() => {});

    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'API failed', detail: err.message });
  }
}
