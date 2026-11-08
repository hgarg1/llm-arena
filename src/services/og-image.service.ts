import fs from 'fs';
import path from 'path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

type OgThemeName = 'home' | 'benchmarks' | 'models' | 'matches' | 'careers' | 'docs' | 'default';

type OgImageOptions = {
  theme?: OgThemeName;
  eyebrow: string;
  title: string;
  description: string;
  chips?: string[];
  metricLabel?: string;
  metricValue?: string;
  footerLeft?: string;
  footerRight?: string;
};

type ThemeConfig = {
  backgroundStart: string;
  backgroundEnd: string;
  panelStroke: string;
  textGlow: string;
  accentA: string;
  accentB: string;
  accentC: string;
  chipFill: string;
  chipStroke: string;
};

type LayoutVariant = 'spotlight' | 'leaderboard' | 'catalog' | 'versus' | 'editorial';

const THEMES: Record<OgThemeName, ThemeConfig> = {
  home: {
    backgroundStart: '#07111E',
    backgroundEnd: '#101A2B',
    panelStroke: 'rgba(148, 163, 184, 0.18)',
    textGlow: 'rgba(14, 165, 233, 0.35)',
    accentA: '#0EA5E9',
    accentB: '#22C55E',
    accentC: '#F97316',
    chipFill: 'rgba(15, 23, 42, 0.8)',
    chipStroke: 'rgba(125, 211, 252, 0.3)'
  },
  benchmarks: {
    backgroundStart: '#140B24',
    backgroundEnd: '#1A1231',
    panelStroke: 'rgba(196, 181, 253, 0.18)',
    textGlow: 'rgba(168, 85, 247, 0.35)',
    accentA: '#A855F7',
    accentB: '#EC4899',
    accentC: '#F59E0B',
    chipFill: 'rgba(30, 27, 75, 0.76)',
    chipStroke: 'rgba(216, 180, 254, 0.32)'
  },
  models: {
    backgroundStart: '#08151C',
    backgroundEnd: '#11212A',
    panelStroke: 'rgba(45, 212, 191, 0.16)',
    textGlow: 'rgba(45, 212, 191, 0.28)',
    accentA: '#14B8A6',
    accentB: '#0EA5E9',
    accentC: '#FACC15',
    chipFill: 'rgba(15, 23, 42, 0.78)',
    chipStroke: 'rgba(94, 234, 212, 0.25)'
  },
  matches: {
    backgroundStart: '#180C0C',
    backgroundEnd: '#271515',
    panelStroke: 'rgba(251, 113, 133, 0.16)',
    textGlow: 'rgba(248, 113, 113, 0.34)',
    accentA: '#FB7185',
    accentB: '#F97316',
    accentC: '#FACC15',
    chipFill: 'rgba(30, 20, 20, 0.82)',
    chipStroke: 'rgba(253, 164, 175, 0.3)'
  },
  careers: {
    backgroundStart: '#0C1326',
    backgroundEnd: '#131E35',
    panelStroke: 'rgba(129, 140, 248, 0.18)',
    textGlow: 'rgba(129, 140, 248, 0.34)',
    accentA: '#818CF8',
    accentB: '#38BDF8',
    accentC: '#34D399',
    chipFill: 'rgba(15, 23, 42, 0.8)',
    chipStroke: 'rgba(165, 180, 252, 0.3)'
  },
  docs: {
    backgroundStart: '#101317',
    backgroundEnd: '#1B2129',
    panelStroke: 'rgba(203, 213, 225, 0.14)',
    textGlow: 'rgba(203, 213, 225, 0.2)',
    accentA: '#E2E8F0',
    accentB: '#38BDF8',
    accentC: '#22C55E',
    chipFill: 'rgba(15, 23, 42, 0.76)',
    chipStroke: 'rgba(226, 232, 240, 0.2)'
  },
  default: {
    backgroundStart: '#08111F',
    backgroundEnd: '#111827',
    panelStroke: 'rgba(148, 163, 184, 0.16)',
    textGlow: 'rgba(56, 189, 248, 0.22)',
    accentA: '#38BDF8',
    accentB: '#22C55E',
    accentC: '#F97316',
    chipFill: 'rgba(15, 23, 42, 0.78)',
    chipStroke: 'rgba(148, 163, 184, 0.24)'
  }
};

const REGULAR_FONT_FAMILY = 'ArenaPreviewRegular';
const BOLD_FONT_FAMILY = 'ArenaPreviewBold';
const LAYOUT_VARIANT: Record<OgThemeName, LayoutVariant> = {
  home: 'spotlight',
  benchmarks: 'leaderboard',
  models: 'catalog',
  matches: 'versus',
  careers: 'editorial',
  docs: 'editorial',
  default: 'editorial'
};

const registerFontIfPresent = (candidatePaths: string[], family: string) => {
  const fontPath = candidatePaths.find(candidate => fs.existsSync(candidate));
  if (!fontPath) return false;
  try {
    return GlobalFonts.registerFromPath(fontPath, family);
  } catch {
    return false;
  }
};

registerFontIfPresent(
  [
    path.resolve(process.cwd(), 'src/assets/fonts/Arial.ttf'),
    path.resolve(__dirname, '../assets/fonts/Arial.ttf')
  ],
  REGULAR_FONT_FAMILY
);

registerFontIfPresent(
  [
    path.resolve(process.cwd(), 'src/assets/fonts/Arial-Bold.ttf'),
    path.resolve(__dirname, '../assets/fonts/Arial-Bold.ttf')
  ],
  BOLD_FONT_FAMILY
);

const applyFont = (ctx: any, weight: number, size: number) => {
  const family = weight >= 600 ? BOLD_FONT_FAMILY : REGULAR_FONT_FAMILY;
  ctx.font = `${weight} ${size}px "${family}"`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
};

const fitWrappedText = (ctx: any, options: {
  text: string;
  maxWidth: number;
  maxLines: number;
  startSize: number;
  minSize: number;
  weight: number;
  lineHeightMultiplier: number;
  maxHeight?: number;
}) => {
  for (let size = options.startSize; size >= options.minSize; size -= 2) {
    applyFont(ctx, options.weight, size);
    const lines = wrapText(ctx, options.text, options.maxWidth, options.maxLines);
    const lineHeight = Math.round(size * options.lineHeightMultiplier);
    const height = lineHeight * lines.length;
    const widestLine = lines.reduce((max: number, line: string) => Math.max(max, ctx.measureText(line).width), 0);
    if (
      lines.length <= options.maxLines &&
      widestLine <= options.maxWidth &&
      (!options.maxHeight || height <= options.maxHeight)
    ) {
      return {
        size,
        lines,
        lineHeight,
        height
      };
    }
  }

  applyFont(ctx, options.weight, options.minSize);
  const lines = wrapText(ctx, options.text, options.maxWidth, options.maxLines);
  const normalizedLines = lines.map((line: string) => {
    let output = line;
    while (output.length > 0 && ctx.measureText(output).width > options.maxWidth) {
      output = `${output.slice(0, -2).trimEnd()}...`;
    }
    return output;
  });
  const lineHeight = Math.round(options.minSize * options.lineHeightMultiplier);
  return {
    size: options.minSize,
    lines: normalizedLines,
    lineHeight,
    height: lineHeight * normalizedLines.length
  };
};

const wrapText = (ctx: any, text: string, maxWidth: number, maxLines: number) => {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  words.forEach(word => {
    const next = current ? `${current} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth) {
      current = next;
      return;
    }

    if (current) {
      lines.push(current);
      current = word;
    } else {
      lines.push(word);
      current = '';
    }
  });

  if (current) lines.push(current);

  if (lines.length <= maxLines) return lines;

  const truncated = lines.slice(0, maxLines);
  let lastLine = truncated[maxLines - 1];
  while (lastLine.length > 0 && ctx.measureText(`${lastLine}...`).width > maxWidth) {
    lastLine = lastLine.slice(0, -1).trimEnd();
  }
  truncated[maxLines - 1] = `${lastLine}...`;
  return truncated;
};

const drawRoundedRect = (ctx: any, x: number, y: number, width: number, height: number, radius: number) => {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
};

const hexToRgba = (value: string, alpha: number) => {
  if (!value.startsWith('#')) return value;
  const normalized = value.length === 4
    ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
    : value;
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

const fillRoundedRect = (
  ctx: any,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fillStyle: any,
  strokeStyle?: string,
  lineWidth = 1
) => {
  drawRoundedRect(ctx, x, y, width, height, radius);
  ctx.fillStyle = fillStyle;
  ctx.fill();
  if (strokeStyle) {
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }
};

const drawMetricChip = (ctx: any, theme: ThemeConfig, label: string, value: string, x: number, y: number, width: number) => {
  fillRoundedRect(
    ctx,
    x,
    y,
    width,
    74,
    18,
    'rgba(15, 23, 42, 0.78)',
    hexToRgba(theme.accentA, 0.18),
    2
  );
  ctx.fillStyle = '#8FA3B8';
  applyFont(ctx, 600, 16);
  ctx.fillText(label.toUpperCase(), x + 18, y + 14);
  const valueBlock = fitWrappedText(ctx, {
    text: value,
    maxWidth: width - 36,
    maxLines: 2,
    startSize: 26,
    minSize: 18,
    weight: 700,
    lineHeightMultiplier: 1.02,
    maxHeight: 36
  });
  ctx.fillStyle = '#F8FAFC';
  applyFont(ctx, 700, valueBlock.size);
  valueBlock.lines.forEach((line: string, index: number) => {
    ctx.fillText(line, x + 18, y + 36 + index * valueBlock.lineHeight);
  });
};

const drawSignalDots = (ctx: any, theme: ThemeConfig, x: number, y: number, count: number, gap = 28) => {
  for (let index = 0; index < count; index += 1) {
    ctx.beginPath();
    ctx.arc(x + index * gap, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(index % 2 === 0 ? theme.accentA : theme.accentB, 0.85);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x + index * gap, y, 15, 0, Math.PI * 2);
    ctx.fillStyle = hexToRgba(index % 2 === 0 ? theme.accentA : theme.accentB, 0.12);
    ctx.fill();
  }
};

const drawVisualPanel = (ctx: any, themeName: OgThemeName, theme: ThemeConfig, options: OgImageOptions) => {
  const variant = LAYOUT_VARIANT[themeName];
  const panelX = 742;
  const panelY = 92;
  const panelWidth = 374;
  const panelHeight = 446;

  const panelGradient = ctx.createLinearGradient(panelX, panelY, panelX + panelWidth, panelY + panelHeight);
  panelGradient.addColorStop(0, 'rgba(11, 19, 32, 0.96)');
  panelGradient.addColorStop(1, 'rgba(11, 19, 32, 0.74)');
  fillRoundedRect(ctx, panelX, panelY, panelWidth, panelHeight, 30, panelGradient, theme.panelStroke, 2);

  ctx.strokeStyle = hexToRgba(theme.accentA, 0.12);
  ctx.lineWidth = 1;
  for (let x = panelX + 26; x < panelX + panelWidth - 20; x += 38) {
    ctx.beginPath();
    ctx.moveTo(x, panelY + 24);
    ctx.lineTo(x, panelY + panelHeight - 24);
    ctx.stroke();
  }
  for (let y = panelY + 24; y < panelY + panelHeight - 20; y += 38) {
    ctx.beginPath();
    ctx.moveTo(panelX + 24, y);
    ctx.lineTo(panelX + panelWidth - 24, y);
    ctx.stroke();
  }

  ctx.fillStyle = hexToRgba(theme.accentA, 0.95);
  applyFont(ctx, 700, 18);
  ctx.fillText((options.metricLabel || 'LLM Arena').toUpperCase(), panelX + 28, panelY + 26);

  if (variant === 'leaderboard') {
    const metricBlock = fitWrappedText(ctx, {
      text: options.metricValue || 'Rank + replay',
      maxWidth: panelWidth - 56,
      maxLines: 2,
      startSize: 40,
      minSize: 28,
      weight: 700,
      lineHeightMultiplier: 1.08,
      maxHeight: 92
    });
    ctx.fillStyle = '#F8FAFC';
    applyFont(ctx, 700, metricBlock.size);
    metricBlock.lines.forEach((line, index) => {
      ctx.fillText(line, panelX + 28, panelY + 58 + index * metricBlock.lineHeight);
    });

    const rows = [
      { label: 'Top model', tone: theme.accentA, width: 0.84 },
      { label: 'Replay score', tone: theme.accentB, width: 0.68 },
      { label: 'Coverage', tone: theme.accentC, width: 0.56 }
    ];
    rows.forEach((row, index) => {
      const y = panelY + 172 + index * 72;
      fillRoundedRect(ctx, panelX + 28, y, panelWidth - 56, 52, 18, 'rgba(15, 23, 42, 0.82)', hexToRgba(theme.accentA, 0.14), 2);
      ctx.fillStyle = '#DCE7F4';
      applyFont(ctx, 600, 18);
      ctx.fillText(`0${index + 1}`, panelX + 46, y + 16);
      ctx.fillStyle = '#8FA3B8';
      applyFont(ctx, 600, 15);
      ctx.fillText(row.label.toUpperCase(), panelX + 92, y + 12);
      fillRoundedRect(ctx, panelX + 92, y + 30, 200, 8, 4, 'rgba(30, 41, 59, 0.95)');
      const barGradient = ctx.createLinearGradient(panelX + 92, y + 30, panelX + 292, y + 30);
      barGradient.addColorStop(0, row.tone);
      barGradient.addColorStop(1, hexToRgba(row.tone, 0.45));
      fillRoundedRect(ctx, panelX + 92, y + 30, Math.floor(200 * row.width), 8, 4, barGradient);
    });

    drawMetricChip(ctx, theme, options.footerLeft || 'Evidence', options.footerRight || 'Public data', panelX + 28, panelY + 378, panelWidth - 56);
    return;
  }

  if (variant === 'catalog') {
    const metricBlock = fitWrappedText(ctx, {
      text: options.metricValue || 'Active listing',
      maxWidth: panelWidth - 56,
      maxLines: 2,
      startSize: 38,
      minSize: 28,
      weight: 700,
      lineHeightMultiplier: 1.1,
      maxHeight: 88
    });
    ctx.fillStyle = '#F8FAFC';
    applyFont(ctx, 700, metricBlock.size);
    metricBlock.lines.forEach((line, index) => {
      ctx.fillText(line, panelX + 28, panelY + 58 + index * metricBlock.lineHeight);
    });

    ctx.strokeStyle = hexToRgba(theme.accentB, 0.45);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(panelX + 282, panelY + 158, 70, -Math.PI * 0.15, Math.PI * 1.3);
    ctx.stroke();
    ctx.strokeStyle = hexToRgba(theme.accentA, 0.72);
    ctx.beginPath();
    ctx.arc(panelX + 282, panelY + 158, 48, Math.PI * 0.2, Math.PI * 1.65);
    ctx.stroke();
    drawSignalDots(ctx, theme, panelX + 248, panelY + 158, 3, 24);

    const detailRows = [
      options.footerLeft || 'Model record',
      options.footerRight || 'Provider route',
      (options.chips || []).slice(0, 2).join('  /  ') || 'Capability metadata'
    ];
    detailRows.forEach((row, index) => {
      const y = panelY + 250 + index * 46;
      fillRoundedRect(ctx, panelX + 28, y, panelWidth - 56, 34, 14, 'rgba(15, 23, 42, 0.76)', hexToRgba(theme.accentA, 0.12), 1);
      ctx.fillStyle = index === 2 ? '#DCE7F4' : '#8FA3B8';
      applyFont(ctx, index === 2 ? 600 : 500, index === 2 ? 16 : 15);
      ctx.fillText(row, panelX + 16, y + 8);
    });

    drawMetricChip(ctx, theme, 'Catalog', 'Structured', panelX + 28, panelY + 384, 154);
    drawMetricChip(ctx, theme, 'Replay', 'Ready', panelX + 192, panelY + 384, 154);
    return;
  }

  if (variant === 'versus') {
    const metricBlock = fitWrappedText(ctx, {
      text: options.metricValue || 'Public replays',
      maxWidth: panelWidth - 56,
      maxLines: 2,
      startSize: 40,
      minSize: 28,
      weight: 700,
      lineHeightMultiplier: 1.08,
      maxHeight: 88
    });
    ctx.fillStyle = '#F8FAFC';
    applyFont(ctx, 700, metricBlock.size);
    metricBlock.lines.forEach((line, index) => {
      ctx.fillText(line, panelX + 28, panelY + 58 + index * metricBlock.lineHeight);
    });

    fillRoundedRect(ctx, panelX + 28, panelY + 162, 144, 156, 22, 'rgba(15, 23, 42, 0.84)', hexToRgba(theme.accentA, 0.18), 2);
    fillRoundedRect(ctx, panelX + 202, panelY + 162, 144, 156, 22, 'rgba(15, 23, 42, 0.84)', hexToRgba(theme.accentB, 0.18), 2);
    ctx.fillStyle = '#F8FAFC';
    applyFont(ctx, 700, 22);
    ctx.fillText('A', panelX + 48, panelY + 188);
    ctx.fillText('B', panelX + 222, panelY + 188);
    fillRoundedRect(ctx, panelX + 154, panelY + 218, 66, 44, 22, 'rgba(8, 15, 26, 0.95)', hexToRgba(theme.accentC, 0.28), 2);
    ctx.fillStyle = theme.accentC;
    applyFont(ctx, 700, 20);
    ctx.fillText('VS', panelX + 171, panelY + 229);
    fillRoundedRect(ctx, panelX + 52, panelY + 260, 92, 8, 4, 'rgba(30, 41, 59, 0.95)');
    fillRoundedRect(ctx, panelX + 52, panelY + 260, 74, 8, 4, theme.accentA);
    fillRoundedRect(ctx, panelX + 226, panelY + 260, 92, 8, 4, 'rgba(30, 41, 59, 0.95)');
    fillRoundedRect(ctx, panelX + 226, panelY + 260, 58, 8, 4, theme.accentB);

    drawMetricChip(ctx, theme, options.footerLeft || 'Game type', options.footerRight || 'Replay log', panelX + 28, panelY + 344, panelWidth - 56);
    return;
  }

  if (variant === 'spotlight') {
    const metricBlock = fitWrappedText(ctx, {
      text: options.metricValue || 'Evaluation integrity',
      maxWidth: panelWidth - 56,
      maxLines: 2,
      startSize: 40,
      minSize: 30,
      weight: 700,
      lineHeightMultiplier: 1.08,
      maxHeight: 90
    });
    ctx.fillStyle = '#F8FAFC';
    applyFont(ctx, 700, metricBlock.size);
    metricBlock.lines.forEach((line, index) => {
      ctx.fillText(line, panelX + 28, panelY + 58 + index * metricBlock.lineHeight);
    });

    const halo = ctx.createRadialGradient(panelX + 250, panelY + 212, 20, panelX + 250, panelY + 212, 170);
    halo.addColorStop(0, hexToRgba(theme.accentA, 0.34));
    halo.addColorStop(1, hexToRgba(theme.accentA, 0));
    ctx.fillStyle = halo;
    ctx.fillRect(panelX + 80, panelY + 100, 280, 220);
    drawSignalDots(ctx, theme, panelX + 120, panelY + 244, 5, 38);

    const stepLabels = ['Capture', 'Score', 'Replay'];
    stepLabels.forEach((label, index) => {
      const x = panelX + 40 + index * 106;
      const y = panelY + 320;
      fillRoundedRect(ctx, x, y, 90, 60, 18, 'rgba(15, 23, 42, 0.8)', hexToRgba(theme.accentA, 0.14), 2);
      ctx.fillStyle = '#8FA3B8';
      applyFont(ctx, 600, 13);
      ctx.fillText(label.toUpperCase(), x + 16, y + 12);
      ctx.fillStyle = '#F8FAFC';
      applyFont(ctx, 700, 22);
      ctx.fillText(`0${index + 1}`, x + 16, y + 30);
    });

    drawMetricChip(ctx, theme, options.footerLeft || 'Workflow', options.footerRight || 'Canonical preview', panelX + 28, panelY + 390, panelWidth - 56);
    return;
  }

  const metricBlock = fitWrappedText(ctx, {
    text: options.metricValue || 'Operator ready',
    maxWidth: panelWidth - 56,
    maxLines: 2,
    startSize: 40,
    minSize: 28,
    weight: 700,
    lineHeightMultiplier: 1.08,
    maxHeight: 90
  });
  ctx.fillStyle = '#F8FAFC';
  applyFont(ctx, 700, metricBlock.size);
  metricBlock.lines.forEach((line, index) => {
    ctx.fillText(line, panelX + 28, panelY + 58 + index * metricBlock.lineHeight);
  });

  fillRoundedRect(ctx, panelX + 28, panelY + 152, panelWidth - 56, 130, 24, 'rgba(15, 23, 42, 0.84)', hexToRgba(theme.accentB, 0.18), 2);
  ctx.fillStyle = '#CBD5E1';
  applyFont(ctx, 500, 18);
  ctx.fillText(options.footerLeft || 'LLM Arena', panelX + 48, panelY + 182);
  const footerBlock = fitWrappedText(ctx, {
    text: options.footerRight || 'Canonical reference',
    maxWidth: panelWidth - 96,
    maxLines: 2,
    startSize: 28,
    minSize: 20,
    weight: 700,
    lineHeightMultiplier: 1.14,
    maxHeight: 68
  });
  ctx.fillStyle = '#F8FAFC';
  applyFont(ctx, 700, footerBlock.size);
  footerBlock.lines.forEach((line, index) => {
    ctx.fillText(line, panelX + 48, panelY + 208 + index * footerBlock.lineHeight);
  });

  drawMetricChip(ctx, theme, 'Signal', 'Structured', panelX + 28, panelY + 314, 154);
  drawMetricChip(ctx, theme, 'View', 'Shareable', panelX + 192, panelY + 314, 154);
  drawSignalDots(ctx, theme, panelX + 84, panelY + 422, 6, 34);
};

const drawChip = (ctx: any, theme: ThemeConfig, label: string, x: number, y: number) => {
  applyFont(ctx, 600, 22);
  const width = Math.ceil(ctx.measureText(label).width) + 34;
  drawRoundedRect(ctx, x, y, width, 44, 22);
  ctx.fillStyle = theme.chipFill;
  ctx.fill();
  ctx.strokeStyle = theme.chipStroke;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#E2E8F0';
  ctx.fillText(label, x + 17, y + 11);
  return width;
};

export const renderOgImage = (options: OgImageOptions) => {
  const theme = THEMES[options.theme || 'default'];
  const themeName = options.theme || 'default';
  const canvas = createCanvas(OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT);
  const ctx = canvas.getContext('2d');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  const background = ctx.createLinearGradient(0, 0, OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT);
  background.addColorStop(0, theme.backgroundStart);
  background.addColorStop(1, theme.backgroundEnd);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT);

  const glow = ctx.createRadialGradient(210, 140, 20, 210, 140, 280);
  glow.addColorStop(0, `${theme.accentA}55`);
  glow.addColorStop(1, `${theme.accentA}00`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT);

  const cornerGlow = ctx.createRadialGradient(980, 500, 10, 980, 500, 340);
  cornerGlow.addColorStop(0, `${theme.accentC}45`);
  cornerGlow.addColorStop(1, `${theme.accentC}00`);
  ctx.fillStyle = cornerGlow;
  ctx.fillRect(0, 0, OG_IMAGE_WIDTH, OG_IMAGE_HEIGHT);

  for (let i = 0; i < 5; i += 1) {
    ctx.fillStyle = [theme.accentA, theme.accentB, theme.accentC][i % 3] + '18';
    ctx.beginPath();
    ctx.arc(180 + i * 210, 70 + (i % 2) * 20, 6 + i * 2, 0, Math.PI * 2);
    ctx.fill();
  }

  drawRoundedRect(ctx, 44, 44, OG_IMAGE_WIDTH - 88, OG_IMAGE_HEIGHT - 88, 32);
  ctx.fillStyle = 'rgba(8, 15, 26, 0.48)';
  ctx.fill();
  ctx.strokeStyle = theme.panelStroke;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.strokeStyle = hexToRgba(theme.accentA, 0.16);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(688, 76);
  ctx.lineTo(688, 554);
  ctx.stroke();

  ctx.save();
  ctx.translate(82, 92);
  ctx.fillStyle = theme.accentA;
  applyFont(ctx, 700, 22);
  ctx.fillText(options.eyebrow.toUpperCase(), 0, 0);
  ctx.restore();

  const chipY = 496;
  const titleMaxWidth = themeName === 'benchmarks' ? 548 : themeName === 'docs' ? 560 : 578;
  const titleBlock = fitWrappedText(ctx, {
    text: options.title,
    maxWidth: titleMaxWidth,
    maxLines: 3,
    startSize: themeName === 'docs' ? 54 : 60,
    minSize: 38,
    weight: 700,
    lineHeightMultiplier: 1.08,
    maxHeight: 180
  });
  const titleY = 150;

  ctx.shadowColor = theme.textGlow;
  ctx.shadowBlur = 24;
  ctx.fillStyle = '#F8FAFC';
  applyFont(ctx, 700, titleBlock.size);
  titleBlock.lines.forEach((line, index) => {
    ctx.fillText(line, 82, titleY + index * titleBlock.lineHeight);
  });

  ctx.shadowBlur = 0;
  const descriptionY = titleY + titleBlock.height + 22;
  const descriptionMaxHeight = chipY - descriptionY - 28;
  const descriptionMaxLines = Math.max(2, Math.min(3, Math.floor(descriptionMaxHeight / 34)));
  const descriptionBlock = fitWrappedText(ctx, {
    text: options.description,
    maxWidth: titleMaxWidth + 20,
    maxLines: descriptionMaxLines,
    startSize: 25,
    minSize: 22,
    weight: 400,
    lineHeightMultiplier: 1.28,
    maxHeight: descriptionMaxHeight
  });
  ctx.fillStyle = '#CBD5E1';
  applyFont(ctx, 400, descriptionBlock.size);
  descriptionBlock.lines.forEach((line, index) => {
    ctx.fillText(line, 86, descriptionY + index * descriptionBlock.lineHeight);
  });

  const chipLabels = (options.chips || []).slice(0, 4);
  let chipX = 82;
  chipLabels.forEach((chip, index) => {
    chipX += index === 0 ? 0 : 14;
    chipX += drawChip(ctx, theme, chip, chipX, chipY);
  });

  drawVisualPanel(ctx, themeName, theme, options);

  return canvas.toBuffer('image/png');
};
