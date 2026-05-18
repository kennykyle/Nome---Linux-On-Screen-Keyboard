import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

const read = file => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const exists = file => fs.existsSync(path.join(repoRoot, file));

const jsFiles = fs.readdirSync(repoRoot)
    .filter(file => file.endsWith('.js') || file.endsWith('.mjs'));

function lineNumber(text, index) {
    return text.slice(0, index).split('\n').length;
}

for (const file of jsFiles) {
    const text = read(file);
    const imports = text.matchAll(
        /(?:import|export)\s+(?:[^'"]+\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g);
    for (const match of imports) {
        const target = path.normalize(path.join(path.dirname(file), match[1]));
        assert.ok(exists(target), `${file} imports missing file ${match[1]}`);
    }
}

const splitArtifactPatterns = [
    {
        re: /function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*function\s+[A-Za-z_$][\w$]*/g,
        description: 'duplicated function opener',
    },
    {
        re: /\/\/\s*([A-Za-z][^.\n]{4,100}\.)\/\/\s*\1/g,
        description: 'duplicated sentence comment',
    },
    {
        re: /\/\/[^\n]*\/\/\s*={4,}/g,
        description: 'merged section-header comment',
    },
];

for (const file of jsFiles.filter(file => file.endsWith('.js'))) {
    const text = read(file);
    for (const { re, description } of splitArtifactPatterns) {
        re.lastIndex = 0;
        const match = re.exec(text);
        assert.equal(match, null,
            `${file}:${match ? lineNumber(text, match.index) : '?'} has ${description}`);
    }

    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!/^\/\/\s+[A-Za-z0-9][^=]*[A-Za-z0-9]$/.test(line))
            continue;
        for (let j = i + 1; j <= Math.min(i + 3, lines.length - 1); j++) {
            assert.notEqual(lines[j].trim(), line,
                `${file}:${j + 1} repeats nearby comment header ${line}`);
        }
    }
}

const shippedFiles = [
    'extension.js',
    'layouts.js',
    'lifecycle.js',
    'theme.js',
    'dataPaths.js',
    'modalAuth.js',
    'rgbEffects.js',
    'keyboard.js',
    'indicator.js',
    'predictor.js',
    'stylesheet.css',
    'seed-bigrams.txt',
];

const installScript = read('install.sh');
const releaseScript = read('make-release.sh');

for (const file of shippedFiles) {
    assert.match(installScript, new RegExp(file.replace('.', '\\.')),
        `install.sh does not mention ${file}`);
    assert.match(releaseScript, new RegExp(file.replace('.', '\\.')),
        `make-release.sh does not package ${file}`);
}

assert.match(installScript, /extract_build_tag "\$SCRIPT_DIR\/dataPaths\.js"/,
    'install.sh should read OSK_BUILD_TAG from dataPaths.js');
assert.doesNotMatch(installScript, /grep -oE "OSK_BUILD_TAG[^"]*" "\$SCRIPT_DIR\/extension\.js"/,
    'install.sh must not grep extension.js for OSK_BUILD_TAG');
assert.match(installScript, /DOWNLOAD_PREDICTION_DATA=1/,
    'install.sh should download prediction data by default');
assert.match(installScript, /--no-download-prediction-data/,
    'install.sh should provide an offline install escape hatch');
assert.doesNotMatch(installScript, /WORDLIST_RANGE_BYTES/,
    'install.sh should not range-download a partial wordlist');

console.log('package consistency passed');
