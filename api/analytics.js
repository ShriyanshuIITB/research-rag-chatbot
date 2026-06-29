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

  // Get all papers for this professor
  const { data: papers } = await supabase
    .from('papers')
    .select('id, title')
    .eq('professor_id', professorId);

  if (!papers || papers.length === 0) {
    return res.status(200).json({ analytics: [] });
  }

  const paperIds = papers.map(p => p.id);

  // Get question logs for all papers
  const { data: logs } = await supabase
    .from('question_logs')
    .select('paper_id, question, answered, created_at')
    .in('paper_id', paperIds)
    .order('created_at', { ascending: false });

  // Build analytics per paper
  const analytics = papers.map(paper => {
    const paperLogs = logs?.filter(l => l.paper_id === paper.id) || [];
    const totalQuestions = paperLogs.length;
    const answeredQuestions = paperLogs.filter(l => l.answered).length;
    const unanswered = paperLogs.filter(l => !l.answered).length;
    const recentQuestions = paperLogs.slice(0, 5).map(l => l.question);

    return {
      paperId: paper.id,
      paperTitle: paper.title,
      totalQuestions,
      answeredQuestions,
      unanswered,
      recentQuestions
    };
  });

  res.status(200).json({ analytics });
}
