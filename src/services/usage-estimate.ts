/** Rough token count (about 3.5 characters per token for English and JSON), good enough for budgets and limits. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.5);
