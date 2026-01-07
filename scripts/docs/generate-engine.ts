import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { getGameEngine } from '../../src/game/registry';

const prisma = new PrismaClient();

async function generateGameDocs() {
  console.log('Generating Game Engine Documentation...');

  const outputPath = path.join(__dirname, '../../docs/games.md');
  
  // Fetch Published Games
  const games = await prisma.gameDefinition.findMany({
    where: { status: 'LIVE' },
    include: {
      settings: true
    }
  });

  let markdown = `# Game Engine Registry\n\n`;
  markdown += `*Auto-generated on ${new Date().toISOString()}*\n\n`;
  markdown += `This document details the rules, mechanics, and configuration of all active games in the LLM Arena.\n\n`;

  if (games.length === 0) {
    markdown += `> No live games found in the registry.\n`;
  }

  for (const game of games) {
    console.log(`Processing ${game.name}...`);
    
    // Attempt to instantiate engine to get prompts/logic if possible
    let engineInfo = '';
    try {
        const engine = await getGameEngine(game.key);
        // In a real scenario, the engine might expose a .getRules() or .getSystemPrompts() method
        // For now we assume the engine exists.
        engineInfo = `\n**Engine Type**: 
${engine.constructor.name}
`;
    } catch (e) {
        engineInfo = `\n> Warning: Could not instantiate engine for ${game.key}\n`;
    }

    markdown += `## ${game.name}\n\n`;
    markdown += `**ID**: 
${game.key}
`;
    markdown += `${engineInfo}\n`;
    markdown += `### Description\n`;
    markdown += `${game.description_long || game.description_short || 'No description provided.'}\n\n`;

    if (game.settings.length > 0) {
      markdown += `### Configuration Settings\n\n`;
      markdown += `| Key | Type | Default | Description |\n`;
      markdown += `| --- | --- | --- | --- |\n`;
      for (const setting of game.settings) {
        let def = setting.default_value ? JSON.stringify(setting.default_value) : '-';
        markdown += `| 
${setting.key}
 | 
${setting.type}
 | ${def} | ${setting.help_text || ''} |\n`;
      }
      markdown += `\n`;
    }

    if (game.capabilities.length > 0) {
        markdown += `### Required Capabilities\n`;
        markdown += game.capabilities.map(c => `- 
${c}
`).join('\n') + '\n\n';
    }

    markdown += `---\n\n`;
  }

  fs.writeFileSync(outputPath, markdown);
  console.log(`Documentation written to ${outputPath}`);
}

generateGameDocs()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
