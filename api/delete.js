import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = req.headers.authorization;
  const token = auth?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { paperId } = req.body;
  if (!paperId) return res.status(400).json({ error: 'Paper ID required' });

  const { data: paper, error: findError } = await supabase
    .from('papers')
    .select('professor_id')
    .eq('id', paperId)
    .single();

  if (findError || paper.professor_id !== token) {
    return res.status(403).json({ error: 'Not authorized to delete this paper' });
  }

  const { error } = await supabase
    .from('papers')
    .delete()
    .eq('id', paperId);

  if (error) return res.status(500).json({ error: error.message });

  res.status(200).json({ success: true });
}
