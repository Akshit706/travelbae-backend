// src/lib/prisma.js
// Creates a single shared database connection for the whole app.
// Always import db from here instead of creating new PrismaClient() elsewhere.

const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();

module.exports = db;
