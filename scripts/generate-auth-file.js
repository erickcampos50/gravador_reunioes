#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ITERATIONS = 250_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

const rootDir = path.resolve(__dirname, '..');
const sourcePath = path.join(rootDir, 'captura-acesso.source.txt');
const outputPath = path.join(rootDir, 'captura-acesso.txt');

function parseSourceLine(line, fallbackLabel) {
  const separatorIndex = [':', '='].reduce((index, separator) => {
    if (index !== -1) return index;
    const foundIndex = line.indexOf(separator);
    return foundIndex > 0 ? foundIndex : -1;
  }, -1);

  if (separatorIndex === -1) {
    return {
      label: fallbackLabel,
      password: line.trim(),
    };
  }

  const label = line.slice(0, separatorIndex).trim() || fallbackLabel;
  const password = line.slice(separatorIndex + 1).trim();
  return { label, password };
}

function loadSourceEntries(sourceText) {
  const entries = [];
  const lines = sourceText.replace(/\r\n/g, '\n').split('\n');

  lines.forEach((rawLine, lineIndex) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;

    const entry = parseSourceLine(line, `acesso-${entries.length + 1}`);
    if (!entry.password) {
      throw new Error(`Linha ${lineIndex + 1} do arquivo fonte está sem senha.`);
    }

    entries.push(entry);
  });

  return entries;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, HASH_BYTES, 'sha256');
  return {
    saltB64: salt.toString('base64'),
    hashB64: hash.toString('base64'),
  };
}

function main() {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `Arquivo fonte não encontrado: ${path.relative(rootDir, sourcePath)}\n` +
      'Crie esse arquivo com uma senha por linha e rode o gerador novamente.'
    );
  }

  const sourceText = fs.readFileSync(sourcePath, 'utf8');
  const entries = loadSourceEntries(sourceText);

  if (!entries.length) {
    throw new Error(
      `Nenhuma senha encontrada em ${path.relative(rootDir, sourcePath)}.\n` +
      'Adicione pelo menos uma senha antes de gerar o arquivo publicado.'
    );
  }

  const outputLines = entries.map(entry => {
    const { saltB64, hashB64 } = hashPassword(entry.password);
    return `${entry.label}|${ITERATIONS}|${saltB64}|${hashB64}`;
  });

  fs.writeFileSync(outputPath, `${outputLines.join('\n')}\n`, 'utf8');

  console.log(`Gerado ${path.relative(rootDir, outputPath)} com ${entries.length} acesso(s).`);
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exitCode = 1;
}
