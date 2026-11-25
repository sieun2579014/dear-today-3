import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import JSZip from 'jszip';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EMOTION_LABELS: Record<string, string> = {
  happy: '행복함',
  calm: '평온함',
  excited: '설렘',
  sad: '우울함',
  angry: '속상함',
  tired: '피곤함',
};

const WEATHER_LABELS: Record<string, string> = {
  sunny: '맑음',
  cloudy: '흐림',
  rainy: '비',
  snowy: '눈',
  night: '밤하늘',
};

function getGeminiClient(): GoogleGenAI {
  return new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '1mb' }));

  app.post('/api/comfort', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawTitle = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
    const rawContent = typeof body.content === 'string' ? body.content.trim().slice(0, 5000) : '';
    const rawEmotion = typeof body.emotion === 'string' ? body.emotion : 'calm';
    const rawWeather = typeof body.weather === 'string' ? body.weather : 'sunny';
    const rawDate = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : '';

    if (!rawTitle && !rawContent) {
      res.status(400).json({ error: '위로 한마디를 생성하려면 일기 제목이나 내용을 입력해주세요.' });
      return;
    }

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      res.status(503).json({
        error: 'Gemini API 키가 설정되지 않았습니다. Settings > Secrets 패널에서 GEMINI_API_KEY를 확인해주세요.',
      });
      return;
    }

    const emotionLabel = EMOTION_LABELS[rawEmotion] ?? '평온함';
    const weatherLabel = WEATHER_LABELS[rawWeather] ?? '맑음';

    const promptParts = [
      rawDate ? `작성 날짜: ${rawDate}` : '',
      `오늘의 기분: ${emotionLabel}`,
      `날씨: ${weatherLabel}`,
      rawTitle ? `일기 제목: ${rawTitle}` : '',
      rawContent ? `일기 본문:\n${rawContent}` : '',
    ].filter(Boolean);

    try {
      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: promptParts.join('\n'),
        config: {
          systemInstruction:
            "당신은 감성 일기장 'MoodLog'의 다정하고 사려 깊은 마음 동반자입니다. 사용자가 작성한 일기의 내용과 기분, 날씨를 세심하게 읽고 진심이 담긴 따뜻한 '오늘의 위로 한마디'를 한국어로 건네주세요. 반드시 2~3문장의 부드러운 해요체로 작성하고, 마크다운 기호나 목록, 과도한 이모지 없이 차분하고 여운이 남는 문장만 출력하세요.",
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.LOW,
          },
        },
      });

      const comfort = response.text?.trim();
      if (!comfort) {
        res.status(502).json({ error: '위로 한마디를 생성하지 못했습니다. 잠시 후 다시 시도해주세요.' });
        return;
      }

      res.json({ comfort });
    } catch (error: unknown) {
      const errObj = error as { status?: number; message?: string };
      const msg = errObj?.message || '';
      const status = errObj?.status;

      if (status === 403 || status === 400 || msg.includes('API_KEY_INVALID') || msg.includes('PERMISSION_DENIED')) {
        res.status(403).json({
          error: 'Gemini API 키가 유효하지 않거나 권한이 없습니다. Settings > Secrets 패널에서 확인해주세요.',
        });
        return;
      }

      if (status === 429 || msg.includes('RESOURCE_EXHAUSTED')) {
        res.status(429).json({ error: '요청이 많아 잠시 쉬고 있어요. 조금 뒤에 다시 시도해주세요.' });
        return;
      }

      console.error('Gemini comfort generation error:', msg);
      res.status(500).json({ error: 'AI 위로 한마디를 생성하는 중 오류가 발생했습니다.' });
    }
  });

  const SAFE_SOURCE_FILES = [
    '.env.example',
    'index.html',
    'metadata.json',
    'package.json',
    'server.ts',
    'tsconfig.json',
    'vite.config.ts',
    'src/App.tsx',
    'src/index.css',
    'src/main.tsx',
    'src/components/MoodIcons.tsx',
    'src/constants/moodlog.ts',
  ];

  app.get('/api/download-source', async (_req: Request, res: Response) => {
    try {
      const zip = new JSZip();
      const baseDir = path.resolve(__dirname);

      for (const relPath of SAFE_SOURCE_FILES) {
        const resolved = path.resolve(baseDir, relPath);
        if (!resolved.startsWith(baseDir + path.sep)) {
          continue;
        }
        if (fs.existsSync(resolved)) {
          const content = await fs.promises.readFile(resolved, 'utf-8');
          zip.file(relPath, content);
        }
      }

      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="moodlog-source.zip"');
      res.send(buffer);
    } catch (error) {
      console.error('Source zip error:', error);
      res.status(500).json({ error: '소스 코드 압축 중 오류가 발생했습니다.' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`MoodLog server running on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
