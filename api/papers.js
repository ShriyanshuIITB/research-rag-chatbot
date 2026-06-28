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

  // Get single paper by ID
  if (req.query.id) {
    const { data, error } = await supabase
      .from('papers')
      .select('id, title, filename, description, enable_context, quick_questions, professor_name, institution, created_at')
      .eq('id', req.query.id)
      .single();

    if (error) return res.status(404).json({ error: 'Paper not found' });
    return res.status(200).json({ paper: data });
  }

  // Get all papers
  const { data, error } = await supabase
    .from('papers')
    .select('id, title, description, professor_name, institution, created_at')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  res.status(200).json({ papers: data });
}
