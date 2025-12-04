#!/usr/bin/env node
/**
 * Custom changeset CLI wrapper with friendlier terminology:
 * - major = breaking changes
 * - feature = new functionality (maps to minor)
 * - fix = bug fixes (maps to patch)
 */

import { createInterface } from 'readline';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function main() {
  console.log('\n🦋 Creating a new changeset\n');

  // Ask for bump type with our terminology
  console.log('What kind of change is this?');
  console.log('  1. fix     - Bug fixes, small improvements');
  console.log('  2. feature - New functionality');
  console.log('  3. major   - Breaking changes\n');

  let bumpType;
  while (!bumpType) {
    const choice = await question('Enter choice (1/2/3 or fix/feature/major): ');
    const normalized = choice.trim().toLowerCase();

    if (normalized === '1' || normalized === 'fix' || normalized === 'patch') {
      bumpType = 'patch';
    } else if (normalized === '2' || normalized === 'feature' || normalized === 'minor') {
      bumpType = 'minor';
    } else if (normalized === '3' || normalized === 'major') {
      bumpType = 'major';
    } else {
      console.log('Invalid choice. Please enter 1, 2, 3, fix, feature, or major.');
    }
  }

  // Ask for description
  console.log('');
  const summary = await question('Describe the change (will appear in changelog):\n> ');

  if (!summary.trim()) {
    console.log('\n❌ Summary cannot be empty');
    rl.close();
    process.exit(1);
  }

  // Generate changeset file
  const changesetDir = join(process.cwd(), '.changeset');
  if (!existsSync(changesetDir)) {
    mkdirSync(changesetDir);
  }

  // Generate a random name like changesets does
  const id = randomBytes(8).toString('hex');
  const filename = `changeset-${id}.md`;
  const filepath = join(changesetDir, filename);

  const content = `---
"mokuro-reader": ${bumpType}
---

${summary.trim()}
`;

  writeFileSync(filepath, content);

  const typeLabel = bumpType === 'patch' ? 'fix' : bumpType === 'minor' ? 'feature' : 'major';
  console.log(`\n✅ Created ${typeLabel} changeset: .changeset/${filename}`);
  console.log("\nDon't forget to commit this file with your changes!");

  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
