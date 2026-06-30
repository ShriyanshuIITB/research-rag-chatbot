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
    // 1. Get professor ID from Authorization header
    const auth = req.headers.authorization;
    const professorId = auth?.replace('Bearer ', '');
    if (!professorId) {
      return res.status(401).json({ error: 'Missing token' });
    }

    // 2. Verify professor exists
    const { data: prof, error: profError } = await supabase
      .from('professors')
      .select('id')
      .eq('id', professorId)
      .maybeSingle();

    if (profError || !prof) {
      return res.status(401).json({ error: 'Professor not found' });
    }

    // 3. Parse form
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

    // 4. Parse PDF
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

    // 5. Insert paper
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

    // 6. Success
    res.status(200).json({
      success: true,
      paperId: paper.id,
      chatLink: `/chat?id=${paper.id}`,
    });

    // 7. Fire background tasks
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
