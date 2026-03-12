import { encode as toonEncode, decode as toonDecode, estimateTokens } from './dist/toon.js';
import { SmartCompressor } from '@ason-format/ason';
import { encode as zonEncode, decode as zonDecode } from 'zon-format';

// --- CLI flags ---
const args = process.argv.slice(2);
const skipLlm = args.includes('--skip-llm');
const llmOnly = args.includes('--llm-only');
const modelFlag = args.find((_, i, a) => a[i - 1] === '--model');
const MODEL = modelFlag || 'claude-sonnet-4-20250514';

// --- Format definitions ---
const asonCompressor = new SmartCompressor();

const FORMATS = [
  {
    name: 'JSON compact',
    encode: (d) => JSON.stringify(d),
    decode: (t) => JSON.parse(t),
  },
  {
    name: 'TOON (pipe)',
    encode: (d) => toonEncode(d, { delimiter: '|' }),
    decode: (t) => toonDecode(t, '|'),
  },
  {
    name: 'ASON',
    encode: (d) => asonCompressor.compress(d),
    decode: (t) => asonCompressor.decompress(t),
  },
  {
    name: 'ZON',
    encode: (d) => zonEncode(d),
    decode: (t) => zonDecode(t),
  },
];

// --- Deep equal (key-order independent) ---
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k, i) => k === keysB[i] && deepEqual(a[k], b[k]));
}

// --- Answer matching ---
function answersMatch(got, expected) {
  const g = String(got).trim().toLowerCase();
  const e = String(expected).trim().toLowerCase();
  if (g === e) return true;
  const gn = Number(g);
  const en = Number(e);
  if (Number.isFinite(gn) && Number.isFinite(en) && Math.abs(gn - en) < 0.01) return true;
  if (Number.isFinite(en)) {
    const match = g.match(/\b[\d.]+\b/);
    if (match && Math.abs(Number(match[0]) - en) < 0.01) return true;
  }
  if (e.length > 2 && g.includes(e)) return true;
  return false;
}

const DATASETS = [
  {
    name: 'small-tabular',
    description: '3 rows, 4 fields',
    data: {
      users: [
        { id: 1, name: 'Alice', email: 'alice@example.com', active: true },
        { id: 2, name: 'Bob', email: 'bob@example.com', active: false },
        { id: 3, name: 'Charlie', email: 'charlie@example.com', active: true },
      ],
    },
    questions: [
      { text: "What is the email of the user with id 2?", expected: "bob@example.com", type: "retrieval" },
      { text: "How many users are active?", expected: "2", type: "reasoning" },
    ],
  },
  {
    name: 'medium-tabular',
    description: '20 rows, 6 fields',
    data: {
      products: Array.from({ length: 20 }, (_, i) => ({
        id: i + 1,
        name: ['Keyboard', 'Mouse', 'Monitor', 'Headset', 'Webcam', 'Desk', 'Chair', 'Lamp', 'Speaker', 'Charger',
               'Cable', 'Hub', 'Stand', 'Mat', 'Pad', 'Clip', 'Mount', 'Rest', 'Tray', 'Shelf'][i],
        category: ['Electronics', 'Electronics', 'Electronics', 'Electronics', 'Electronics',
                   'Furniture', 'Furniture', 'Furniture', 'Audio', 'Electronics',
                   'Accessories', 'Electronics', 'Furniture', 'Accessories', 'Accessories',
                   'Accessories', 'Furniture', 'Furniture', 'Furniture', 'Furniture'][i],
        price: [49.99, 29.99, 299.99, 79.99, 59.99, 199.99, 249.99, 39.99, 89.99, 19.99,
                9.99, 34.99, 44.99, 14.99, 12.99, 4.99, 29.99, 24.99, 54.99, 74.99][i],
        inStock: i % 3 !== 0,
        rating: [4.5, 4.2, 4.8, 4.1, 3.9, 4.6, 4.7, 3.8, 4.3, 4.0,
                 3.5, 4.4, 4.1, 3.7, 3.6, 3.2, 4.0, 3.9, 4.2, 4.5][i],
      })),
    },
    questions: [
      { text: "What is the price of the product named 'Monitor'?", expected: "299.99", type: "retrieval" },
      { text: "What category is the product with id 12?", expected: "Electronics", type: "retrieval" },
      { text: "How many products cost more than $50?", expected: "8", type: "reasoning" },
    ],
  },
  {
    name: 'large-tabular',
    description: '100 rows, 5 fields',
    data: {
      transactions: Array.from({ length: 100 }, (_, i) => ({
        txId: `TX-${String(i + 1).padStart(4, '0')}`,
        amount: Math.round((10 + Math.sin(i) * 50 + 50) * 100) / 100,
        currency: ['USD', 'EUR', 'GBP', 'JPY', 'CAD'][i % 5],
        status: ['completed', 'pending', 'failed'][i % 3],
        merchant: `Merchant-${(i % 10) + 1}`,
      })),
    },
    questions: [
      { text: "What is the status of transaction TX-0042?", expected: "failed", type: "retrieval" },
      { text: "What currency is used by transaction TX-0015?", expected: "CAD", type: "retrieval" },
      { text: "How many transactions have status 'pending'?", expected: "33", type: "reasoning" },
    ],
  },
  {
    name: 'nested-config',
    description: '3 levels deep, no arrays',
    data: {
      config: {
        database: { host: 'db.internal.prod', port: 5432, ssl: true, pool: { min: 2, max: 20 } },
        cache: { provider: 'redis', ttl: 300, host: 'cache.internal.prod', port: 6379 },
        logging: { level: 'info', format: 'json', destination: '/var/log/app.log' },
      },
    },
    questions: [
      { text: "What is the database host?", expected: "db.internal.prod", type: "retrieval" },
      { text: "What is the cache TTL value?", expected: "300", type: "retrieval" },
    ],
  },
  {
    name: 'mixed',
    description: 'tabular + nested in same object',
    data: {
      meta: { version: '2.1.0', region: 'us-east-1', generatedAt: '2026-03-12T10:00:00Z' },
      servers: [
        { hostname: 'web-01', cpu: 45.2, memory: 67.8, status: 'healthy' },
        { hostname: 'web-02', cpu: 78.1, memory: 82.3, status: 'warning' },
        { hostname: 'web-03', cpu: 12.5, memory: 34.1, status: 'healthy' },
        { hostname: 'db-01', cpu: 91.0, memory: 95.2, status: 'critical' },
      ],
    },
    questions: [
      { text: "What is the CPU usage of web-02?", expected: "78.1", type: "retrieval" },
      { text: "What is the version in the metadata?", expected: "2.1.0", type: "retrieval" },
      { text: "How many servers have status 'healthy'?", expected: "2", type: "reasoning" },
    ],
  },
  {
    name: 'single-field',
    description: 'array of objects with 1 field each',
    data: {
      tags: [
        { value: 'javascript' }, { value: 'typescript' }, { value: 'python' },
        { value: 'rust' }, { value: 'go' },
      ],
    },
    questions: [
      { text: "What is the third tag value?", expected: "python", type: "retrieval" },
      { text: "How many tags are there?", expected: "5", type: "reasoning" },
    ],
  },
  {
    name: 'deep-nesting',
    description: '4+ levels with arrays at each level',
    data: {
      company: {
        name: 'Acme Corp',
        departments: [
          {
            name: 'Engineering',
            teams: [
              { name: 'Backend', members: [{ name: 'Alice', role: 'lead' }, { name: 'Bob', role: 'senior' }] },
              { name: 'Frontend', members: [{ name: 'Charlie', role: 'lead' }] },
            ],
          },
          {
            name: 'Sales',
            teams: [
              { name: 'Enterprise', members: [{ name: 'Dana', role: 'lead' }, { name: 'Eve', role: 'junior' }] },
            ],
          },
        ],
      },
    },
    questions: [
      { text: "What role does Bob have?", expected: "senior", type: "retrieval" },
      { text: "How many departments does Acme Corp have?", expected: "2", type: "reasoning" },
      { text: "Which team is Charlie on?", expected: "Frontend", type: "retrieval" },
    ],
  },
  {
    name: 'wide-rows',
    description: '15+ fields per object',
    data: {
      employees: [
        { id: 1, first: 'Alice', last: 'Smith', email: 'alice@co.com', dept: 'Eng', title: 'Senior Dev', salary: 120000, currency: 'USD', startDate: '2020-03-15', office: 'NYC', floor: 12, desk: 'A-42', manager: 'Bob', team: 'Platform', level: 'L5', remote: false },
        { id: 2, first: 'Bob', last: 'Jones', email: 'bob@co.com', dept: 'Eng', title: 'Director', salary: 180000, currency: 'USD', startDate: '2018-01-10', office: 'NYC', floor: 12, desk: 'A-01', manager: 'Carol', team: 'Platform', level: 'L7', remote: false },
        { id: 3, first: 'Carol', last: 'Lee', email: 'carol@co.com', dept: 'Eng', title: 'VP Eng', salary: 250000, currency: 'USD', startDate: '2015-06-01', office: 'SF', floor: 20, desk: 'B-01', manager: 'CEO', team: 'Leadership', level: 'L9', remote: true },
      ],
    },
    questions: [
      { text: "What is Alice's desk number?", expected: "A-42", type: "retrieval" },
      { text: "Who is Bob's manager?", expected: "Carol", type: "retrieval" },
      { text: "How many employees work remotely?", expected: "1", type: "reasoning" },
    ],
  },
  {
    name: 'flat-scalar-array',
    description: 'array of numbers/strings',
    data: {
      scores: [95, 87, 42, 100, 73, 88, 91, 56, 79, 64, 38, 99, 81, 70, 55],
      labels: ['alpha', 'beta', 'gamma', 'delta', 'epsilon'],
    },
    questions: [],
  },
  {
    name: 'sparse-irregular',
    description: 'non-uniform objects (different keys)',
    data: {
      events: [
        { type: 'click', target: 'button-submit', timestamp: 1710000000 },
        { type: 'pageview', url: '/dashboard', referrer: 'google.com', timestamp: 1710000060 },
        { type: 'error', message: 'NullPointerException', stack: 'at line 42', severity: 'high', timestamp: 1710000120 },
        { type: 'click', target: 'nav-home', timestamp: 1710000180 },
      ],
    },
    questions: [
      { text: "What is the severity of the error event?", expected: "high", type: "retrieval" },
      { text: "How many click events are there?", expected: "2", type: "reasoning" },
    ],
  },
  {
    name: 'text-heavy',
    description: 'long string values in tabular rows',
    data: {
      articles: [
        { id: 1, title: 'Introduction to Machine Learning', author: 'Dr. Smith', summary: 'This comprehensive guide covers the fundamentals of machine learning, including supervised and unsupervised learning techniques, neural networks, and practical applications in industry.' },
        { id: 2, title: 'Advanced Database Optimization', author: 'Prof. Jones', summary: 'An in-depth exploration of database query optimization strategies, covering index design, query planning, partitioning approaches, and real-world performance tuning case studies.' },
        { id: 3, title: 'Cloud Architecture Patterns', author: 'Dr. Lee', summary: 'A practical guide to designing scalable cloud architectures, featuring microservices patterns, event-driven design, container orchestration, and multi-region deployment strategies.' },
      ],
    },
    questions: [
      { text: "Who is the author of 'Advanced Database Optimization'?", expected: "Prof. Jones", type: "retrieval" },
      { text: "How many articles are there?", expected: "3", type: "reasoning" },
    ],
  },
  {
    name: 'edge-cases',
    description: 'empty arrays, null values, booleans',
    data: {
      empty: [],
      nullable: { a: null, b: null, c: 'present' },
      flags: { debug: true, verbose: false, dryRun: true },
      nested: { outer: { inner: {} } },
    },
    questions: [],
  },
];
