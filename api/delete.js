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
  const isAdminPassword = token === process.env.ADMIN_PASSWORD;
  const isValidProfessor = token && token.length === 36 && token.includes('-');

  if (!isAdminPassword && !isValidProfessor) {
    return res.status(401).json({ error: 'Unauthorized' });
}

  const { paperId } = req.body;
  if (!paperId) return res.status(400).json({ error: 'Paper ID required' });

  const { error } = await supabase
    .from('papers')
    .delete()
    .eq('id', paperId);

  if (error) return res.status(500).json({ error: error.message });

  res.status(200).json({ success: true });
}
