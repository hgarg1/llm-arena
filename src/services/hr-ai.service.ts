const OPENAI_BASE_URL = 'https://api.openai.com/v1/responses';

const callOpenAI = async (model: string, system: string, input: string) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const res = await fetch(OPENAI_BASE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      input: [
        { role: 'system', content: system },
        { role: 'user', content: input }
      ]
    })
  });
  if (!res.ok) return null;
  const data = await res.json() as any;
  const output = data.output?.[0]?.content?.[0]?.text || '';
  return output;
};

export const extractApplicationData = async (resumeText: string) => {
  const model = process.env.OPENAI_RESUME_MODEL || 'gpt-5.1';
  const system = 'Extract structured applicant data. Respond only with JSON.';
  const prompt = `
Resume:
${resumeText}

Return JSON with keys:
full_name, email, phone, location, linkedin_url, github_url, portfolio_url,
summary, skills (array), experience (array of {company, role, start, end, highlights}),
education (array of {school, degree, field, year}), certifications (array), languages (array).
If unknown, use null or empty arrays.
`;
  const response = await callOpenAI(model, system, prompt);
  if (!response) return null;
  try {
    return JSON.parse(response);
  } catch (err) {
    return null;
  }
};

export const analyzeApplicationSentiment = async (jobDescription: string, applicationPayload: string) => {
  const model = process.env.OPENAI_SENTIMENT_MODEL || 'gpt-4o';
  const system = 'Analyze sentiment and professionalism. Respond only with JSON.';
  const prompt = `
Job description:
${jobDescription}

Application:
${applicationPayload}

Return JSON with keys:
score (0-100), summary, strengths (array), risks (array).
`;
  const response = await callOpenAI(model, system, prompt);
  if (!response) return null;
  try {
    return JSON.parse(response);
  } catch (err) {
    return null;
  }
};

export const analyzeFitToRole = async (jobDescription: string, applicationPayload: string) => {
  const model = process.env.OPENAI_FIT_MODEL || 'gpt-5.2';
  const system = 'Score fit to the role. Respond only with JSON.';
  const prompt = `
Job description:
${jobDescription}

Application:
${applicationPayload}

Return JSON with keys:
score (0-100), summary, gaps (array), signals (array), recommendations (array).
`;
  const response = await callOpenAI(model, system, prompt);
  if (!response) return null;
  try {
    return JSON.parse(response);
  } catch (err) {
    return null;
  }
};
