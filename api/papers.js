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

  if (req.query.id) {
    const { data, error } = await supabase
      .from('papers')
      .select('id, title, description, summary, professor_name, institution, enable_context, quick_questions, processed, created_at')
      .eq('id', req.query.id)
      .single();

    if (error) return res.status(404).json({ error: 'Paper not found' });
    return res.status(200).json({ paper: data });
  }

  const professorId = req.query.professorId;
  if (!professorId) {
    return res.status(400).json({ error: 'professorId required' });
  }

  const { data, error } = await supabase
    .from('papers')
    .select('id, title, description, summary, professor_name, institution, processed, created_at')
    .eq('professor_id', professorId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.status(200).json({ papers: data });
}
