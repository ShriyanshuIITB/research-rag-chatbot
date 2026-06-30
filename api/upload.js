import formidable from 'formidable';
import fs from 'fs';
import pdfParse from 'pdf-parse';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // 1. Get the JWT token from Authorization header
    const auth = req.headers.authorization;
    const token = auth?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Missing token' });
    }

    // 2. Get the user from the token (using Supabase Auth)
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) {
      return res.status(401).json({ error: 'Invalid token', detail: userError?.message });
    }

    const userId = userData.user.id;

    // 3. Look up or create the professor record
    let professorId;
    const { data: prof, error: profError } = await supabase
      .from('professors')
      .select('id')
      .eq('user_id', userId)
      .maybeSingle();

    if (profError) {
      return res.status(500).json({ error: 'Professor lookup failed', detail: profError.message });
    }

    if (prof) {
      professorId = prof.id;
    } else {
      // Create professor if missing
      const { data: newProf, error: createError } = await supabase
        .from('professors')
        .insert({
          user_id: userId,
          name: 'Professor',
          institution: 'Institute'
        })
        .select()
        .single();

      if (createError) {
        return res.status(500).json({ error: 'Failed to create professor', detail: createError.message });
      }
      professorId = newProf.id;
    }

    // 4. Parse form (file + fields)
    const form = formidable({ maxFileSize: 10 * 1024 * 1024, keepExtensions: true });
    const [fields, files] = await form.parse(req);

    const file = files.pdf?.[0];
    if (!file) {
      return res.status(400).json({ error: 'No PDF file' });
    }

    const title = fields.title?.[0] || 'Untitled';
    const description = fields.description?.[0] || '';
    const enableContext = fields.enableContext?.[0] === 'true';
    const quickQuestions = JSON.parse(fields.quickQuestions?.[0] || '[]');
    const profName = fields.profName?.[0] || 'Professor';
    const institution = fields.institution?.[0] || '';

    // 5. Parse PDF
    let fullText = '';
    try {
      const buffer = fs.readFileSync(file.filepath);
      const pdfData = await pdfParse(buffer);
      fullText = pdfData.text;
      if (!fullText || fullText.trim().length === 0) {
        return res.status(400).json({ error: 'PDF is empty or contains only images' });
      }
    } catch (pdfError) {
      return res.status(500).json({ error: 'PDF parsing failed', detail: pdfError.message });
    }

    // 6. Insert paper
    const { data: paper, error: insertError } = await supabase
      .from('papers')
      .insert({
        professor_id: professorId,
        title,
        filename: file.originalFilename || 'unknown.pdf',
        description,
        full_text: fullText,
        enable_context: enableContext,
        quick_questions: quickQuestions,
        processed: false,
        professor_name: profName,
        institution: institution,
      })
      .select()
      .single();

    if (insertError) {
      return res.status(500).json({
        error: 'Database Insert Failed',
        detail: insertError.message,
        code: insertError.code,
        hint: insertError.hint
      });
    }

    // 7. Success
    res.status(200).json({
      success: true,
      paperId: paper.id,
      chatLink: `/chat?id=${paper.id}`,
    });

    // 8. Fire background tasks (process-chunks & generate-summary)
    try {
      const edgeUrl = `${process.env.SUPABASE_URL}/functions/v1/process-chunks`;
      await fetch(edgeUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ paperId: paper.id, text: fullText }),
      }).catch(console.error);

      const summaryUrl = `${process.env.SUPABASE_URL}/functions/v1/generate-summary`;
      await fetch(summaryUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ paperId: paper.id, text: fullText, title: paper.title }),
      }).catch(console.error);
    } catch (bgErr) {
      console.error('Background error:', bgErr);
    }

  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed', detail: err.message, stack: err.stack });
  }
}
