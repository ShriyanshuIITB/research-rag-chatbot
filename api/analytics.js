import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { professorId } = req.query;
  if (!professorId) return res.status(400).json({ error: 'professorId required' });

  const { data: papers } = await supabase
    .from('papers')
    .select('id, title')
    .eq('professor_id', professorId);

  if (!papers || papers.length === 0) {
    return res.status(200).json({ analytics: [] });
  }

  const paperIds = papers.map(p => p.id);

  const { data: logs } = await supabase
    .from('question_logs')
    .select('paper_id, question, answered, created_at')
    .in('paper_id', paperIds)
    .order('created_at', { ascending: false });

  const analytics = papers.map(paper => {
    const paperLogs = logs?.filter(l => l.paper_id === paper.id) || [];
    const total = paperLogs.length;
    const answeredCount = paperLogs.filter(l => l.answered).length;
    const unanswered = total - answeredCount;
    const freq = {};
    paperLogs.forEach(l => {
      freq[l.question] = (freq[l.question] || 0) + 1;
    });
    const topQuestions = Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([q, count]) => ({ question: q, count }));

    const recentQuestions = paperLogs.slice(0, 5).map(l => l.question);

    return {
      paperId: paper.id,
      paperTitle: paper.title,
      totalQuestions: total,
      answeredQuestions: answeredCount,
      unanswered,
      topQuestions,
      recentQuestions,
    };
  });

  res.status(200).json({ analytics });
}
