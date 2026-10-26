import mongoose from 'mongoose';

// Product facts and custom answers, cached by ASIN. Uses MongoDB when
// MONGODB_URI is set (TTL indexes expire old rows), otherwise a Map.

const productSchema = new mongoose.Schema(
  {
    _id: String, // ASIN
    title: String,
    text: String,
    rules: mongoose.Schema.Types.Mixed,
    facts: mongoose.Schema.Types.Mixed,
    provider: String,
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

const answerSchema = new mongoose.Schema(
  {
    asin: { type: String, index: true },
    question: String,
    answer: String,
    evidence: String,
    provider: String,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
answerSchema.index({ asin: 1, question: 1 }, { unique: true });

export const normalizeQuestion = (q) => String(q).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?.!]+$/, '');

export async function createCache({ mongoUri, ttlHours }) {
  const ttlMs = ttlHours * 3_600_000;

  if (mongoUri) {
    productSchema.index({ updatedAt: 1 }, { expireAfterSeconds: ttlHours * 3600 });
    answerSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlHours * 3600 });
    await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 8000 });
    const Product = mongoose.model('Product', productSchema);
    const Answer = mongoose.model('Answer', answerSchema);
    await Promise.all([Product.syncIndexes(), Answer.syncIndexes()]);

    return {
      kind: 'mongodb',
      async getProducts(asins) {
        const rows = await Product.find({
          _id: { $in: asins },
          updatedAt: { $gt: new Date(Date.now() - ttlMs) },
        }).lean();
        return new Map(rows.map((r) => [r._id, r]));
      },
      async putProduct(doc) {
        await Product.updateOne({ _id: doc._id }, { ...doc, updatedAt: new Date() }, { upsert: true });
      },
      async getAnswer(asin, question) {
        return Answer.findOne({
          asin,
          question: normalizeQuestion(question),
          createdAt: { $gt: new Date(Date.now() - ttlMs) },
        }).lean();
      },
      async putAnswer(asin, question, value) {
        await Answer.updateOne(
          { asin, question: normalizeQuestion(question) },
          { ...value, createdAt: new Date() },
          { upsert: true },
        );
      },
      async count() {
        const [products, answers] = await Promise.all([
          Product.estimatedDocumentCount(),
          Answer.estimatedDocumentCount(),
        ]);
        return { products, answers };
      },
    };
  }

  const products = new Map();
  const answers = new Map();
  const alive = (row, field) => row && Date.now() - row[field].getTime() < ttlMs;

  return {
    kind: 'memory',
    async getProducts(asins) {
      const out = new Map();
      for (const a of asins) {
        const row = products.get(a);
        if (alive(row, 'updatedAt')) out.set(a, row);
      }
      return out;
    },
    async putProduct(doc) {
      products.set(doc._id, { ...doc, updatedAt: new Date() });
    },
    async getAnswer(asin, question) {
      const row = answers.get(`${asin}|${normalizeQuestion(question)}`);
      return alive(row, 'createdAt') ? row : null;
    },
    async putAnswer(asin, question, value) {
      answers.set(`${asin}|${normalizeQuestion(question)}`, { asin, ...value, createdAt: new Date() });
    },
    async count() {
      return { products: products.size, answers: answers.size };
    },
  };
}
