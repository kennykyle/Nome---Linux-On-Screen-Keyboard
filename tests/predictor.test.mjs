import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const repoRoot = path.resolve(import.meta.dirname, '..');
const predictorPath = path.join(repoRoot, 'predictor.js');
const files = new Map();
let nextSourceId = 1;

class MockFile {
    constructor(filePath) {
        this.path = filePath;
    }

    query_exists() {
        return files.has(this.path) || fs.existsSync(this.path);
    }

    load_contents() {
        if (files.has(this.path))
            return [true, new TextEncoder().encode(files.get(this.path))];
        return [true, fs.readFileSync(this.path)];
    }

    replace_contents(bytes) {
        files.set(this.path, new TextDecoder('utf-8').decode(bytes));
        return true;
    }
}

const GLib = {
    PRIORITY_LOW: 0,
    SOURCE_REMOVE: false,
    path_get_dirname: filePath => path.dirname(filePath),
    mkdir_with_parents: () => 0,
    source_remove: () => true,
    timeout_add: () => nextSourceId++,
};

const Gio = {
    File: {
        new_for_path: filePath => new MockFile(filePath),
    },
    FileCreateFlags: {
        REPLACE_DESTINATION: 1,
    },
};

function loadPredictorClass() {
    const source = fs.readFileSync(predictorPath, 'utf8')
        .replace(/^import .+;\s*$/gm, '')
        .replace('export class WordPredictor', 'class WordPredictor')
        + '\nglobalThis.WordPredictor = WordPredictor;\n';

    const context = {
        Gio,
        GLib,
        TextDecoder,
        TextEncoder,
        console,
        globalThis: null,
        isFinite,
        log: () => {},
    };
    context.globalThis = context;

    vm.runInNewContext(source, context, { filename: predictorPath });
    return context.WordPredictor;
}

const WordPredictor = loadPredictorClass();
const plainArray = value => Array.from(value);

function predictorWithFiles({ wordlist = '', seedBigrams = '', userData = '' }) {
    files.clear();
    files.set('/wordlist.txt', wordlist);
    files.set('/seed-bigrams.txt', seedBigrams);
    if (userData !== '')
        files.set('/userdata.json', userData);

    const predictor = new WordPredictor();
    predictor.setWordlistPaths(['/wordlist.txt']);
    predictor.setSeedBigramsPaths(['/seed-bigrams.txt']);
    predictor.setUserDataPath('/userdata.json');
    predictor.loadBaseDictionary();
    predictor.loadSeedBigrams();
    return predictor;
}

{
    const predictor = predictorWithFiles({
        wordlist: 'the\nthere\nthen\napple\n',
    });
    assert.deepEqual(
        plainArray(predictor.predict('th', '', 3)),
        ['the', 'there', 'then'],
        'prefix predictions preserve base frequency order');
}

{
    const predictor = predictorWithFiles({
        wordlist: [
            'the 100',
            'the 99',
            'there 50',
            'bad-word 40',
            'abc123 30',
            'supercalifragilisticexpialidocious 20',
        ].join('\n'),
    });
    const stats = predictor.stats();
    assert.equal(
        stats.baseWords,
        2,
        'wordlist loading counts unique supported word tokens only');
    assert.equal(
        stats.baseSourceEntries,
        6,
        'wordlist source entries count all non-empty source rows');
    assert.deepEqual(
        plainArray(predictor.predict('th', '', 3)),
        ['the', 'there'],
        'wordlist counts column is ignored without corrupting suggestions');
}

{
    const predictor = predictorWithFiles({
        wordlist: 'zebra\nzeal\n',
    });
    assert.deepEqual(plainArray(predictor.predict('zo', '', 3)), []);
    predictor.learn('zoo', '');
    assert.deepEqual(
        plainArray(predictor.predict('zo', '', 3)),
        ['zoo'],
        'learned user-only words are indexed');
}

{
    const predictor = predictorWithFiles({
        wordlist: 'the\nof\nthere\nhello\n',
        seedBigrams: 'hello there 15\n',
    });
    assert.equal(
        predictor.predict('', 'hello', 3)[0],
        'there',
        'seed bigrams lead no-prefix next-word predictions');
}

{
    const predictor = predictorWithFiles({
        wordlist: '',
        seedBigrams: 'hello there 15\nhello world 12\nthere is 8\n',
    });
    const stats = predictor.stats();
    assert.equal(stats.seedBigramContexts, 2);
    assert.equal(stats.seedBigramPairs, 3);
}

{
    const predictor = predictorWithFiles({
        wordlist: '',
        seedBigrams: 'the time 15\nthe way 12\nthis is 10\nthere are 8\n',
    });
    assert.deepEqual(
        plainArray(predictor.predict('th', '', 3)),
        ['the', 'this', 'there'],
        'seed bigrams bootstrap prefix predictions without a wordlist');
}

{
    const predictor = predictorWithFiles({
        wordlist: '',
        seedBigrams: 'the time 15\n',
    });
    assert.deepEqual(plainArray(predictor.predict('th', '', 3)), ['the']);
    files.set('/seed-bigrams.txt', '');
    predictor.loadSeedBigrams();
    assert.deepEqual(
        plainArray(predictor.predict('th', '', 3)),
        [],
        'seed fallback words are removed when seed data reloads empty');
}

{
    const predictor = predictorWithFiles({
        wordlist: 'the\nagain\nthere\nhello\n',
        seedBigrams: 'hello there 15\n',
    });
    predictor.learn('again', 'hello');
    assert.equal(
        predictor.predict('', 'hello', 3)[0],
        'again',
        'user-learned bigrams outrank seeded bigrams');
}

{
    const predictor = predictorWithFiles({
        wordlist: 'alpha\nbeta\n',
        userData: '{ this is not json',
    });
    assert.doesNotThrow(() => predictor.loadUserData());
    assert.deepEqual(
        plainArray(predictor.predict('a', '', 2)),
        ['alpha'],
        'corrupt user data does not break base predictions');
}

{
    const predictor = predictorWithFiles({
        wordlist: 'alpha\nbeta\n',
    });
    predictor.learn('alpha', 'beta');
    predictor.destroy();
    const saved = JSON.parse(files.get('/userdata.json'));
    assert.equal(saved.userBoost.alpha, 1);
    assert.equal(saved.bigrams.beta.alpha, 1);
}

console.log('predictor tests passed');
