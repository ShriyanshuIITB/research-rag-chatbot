import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action, name, institution, email, password } = req.body;

  // REGISTER
  if (action === 'register') {
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }

    // Check if email already exists
    const { data: existing } = await supabase
      .from('professors')
      .select('id')
      .eq('email', email.toLowerCase())
      .single();

    if (existing) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const { data: professor, error } = await supabase
      .from('professors')
      .insert({
        name,
        institution: institution || '',
        email: email.toLowerCase(),
        password
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ 
      success: true, 
      professor: {
        id: professor.id,
        name: professor.name,
        institution: professor.institution,
        email: professor.email
      }
    });
  }

  // LOGIN
  if (action === 'login') {
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const { data: professor, error } = await supabase
      .from('professors')
      .select('id, name, institution, email')
      .eq('email', email.toLowerCase())
      .eq('password', password)
      .single();

    if (error || !professor) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    return res.status(200).json({ 
      success: true,
      professor: {
        id: professor.id,
        name: professor.name,
        institution: professor.institution,
        email: professor.email
      }
    });
  }

  return res.status(400).json({ error: 'Invalid action' });
}
