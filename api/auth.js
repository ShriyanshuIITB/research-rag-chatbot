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

  const { action, email, password, name, institution } = req.body;

  // REGISTER
  if (action === 'register') {
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
    });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    const userId = authData.user.id;

    // Create professor profile
    const { data: prof, error: profError } = await supabase
      .from('professors')
      .insert({
        user_id: userId,
        name,
        institution: institution || '',
      })
      .select()
      .single();

    if (profError) {
      await supabase.auth.admin.deleteUser(userId);
      return res.status(500).json({ error: profError.message });
    }

    return res.status(200).json({
      success: true,
      professor: {
        id: prof.id,
        name: prof.name,
        institution: prof.institution,
        email: authData.user.email,
      },
    });
  }

  // LOGIN (auto‑creates professor if missing)
  if (action === 'login') {
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const userId = authData.user.id;

    // Try to find existing professor
    let { data: prof, error: profError } = await supabase
      .from('professors')
      .select('id, name, institution')
      .eq('user_id', userId)
      .maybeSingle();

    // If no professor, create one
    if (!prof) {
      const { data: newProf, error: createError } = await supabase
        .from('professors')
        .insert({
          user_id: userId,
          name: authData.user.user_metadata?.name || 'Professor',
          institution: authData.user.user_metadata?.institution || '',
        })
        .select()
        .single();

      if (createError) {
        return res.status(500).json({ error: 'Failed to create professor profile', detail: createError.message });
      }
      prof = newProf;
    }

    return res.status(200).json({
      success: true,
      professor: {
        id: prof.id,
        name: prof.name,
        institution: prof.institution,
        email: authData.user.email,
      },
    });
  }

  return res.status(400).json({ error: 'Invalid action' });
}
