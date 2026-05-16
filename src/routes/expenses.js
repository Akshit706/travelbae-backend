// src/routes/expenses.js
// Handles expenses inside a trip.
//
// GET    /trips/:id/expenses        — list all expenses
// POST   /trips/:id/expenses        — add a new expense
// DELETE /trips/:id/expenses/:expId — delete an expense

const express = require('express');
const db = require('../lib/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// Helper: confirm the user is in the trip
async function requireMembership(tripId, userId) {
  const m = await db.tripMember.findFirst({ where: { tripId, userId } });
  return m; // null if not a member
}

// ── LIST EXPENSES ───────────────────────────────────────
router.get('/:id/expenses', async (req, res) => {
  const membership = await requireMembership(req.params.id, req.userId);
  if (!membership) return res.status(403).json({ error: 'Not a member of this trip.' });

  const expenses = await db.expense.findMany({
    where: { tripId: req.params.id },
    orderBy: { date: 'desc' },
  });
  res.json({ expenses });
});

// ── ADD EXPENSE ─────────────────────────────────────────
// Body: { desc, amount, paidBy, cat, split, note, date }
// split is an array of nicknames, e.g. ["Arjun", "Priya"]
router.post('/:id/expenses', async (req, res) => {
  const membership = await requireMembership(req.params.id, req.userId);
  if (!membership) return res.status(403).json({ error: 'Not a member of this trip.' });

  const { desc, amount, paidBy, cat, split, note, date } = req.body;

  if (!desc || !amount || !paidBy || !cat || !split) {
    return res.status(400).json({ error: 'desc, amount, paidBy, cat, and split are required.' });
  }

  try {
    const expense = await db.expense.create({
      data: {
        tripId: req.params.id,
        desc,
        amount: parseFloat(amount),
        paidBy,
        cat,
        split, // Prisma stores this as a PostgreSQL text array
        note: note || null,
        date: date ? new Date(date) : new Date(),
      },
    });
    res.status(201).json({ expense });
  } catch (err) {
    console.error('Add expense error:', err);
    res.status(500).json({ error: 'Could not add expense.' });
  }
});

// ── DELETE EXPENSE ──────────────────────────────────────
router.delete('/:id/expenses/:expId', async (req, res) => {
  const membership = await requireMembership(req.params.id, req.userId);
  if (!membership) return res.status(403).json({ error: 'Not a member of this trip.' });

  try {
    await db.expense.delete({ where: { id: req.params.expId } });
    res.json({ message: 'Expense deleted.' });
  } catch (err) {
    res.status(404).json({ error: 'Expense not found.' });
  }
});

module.exports = router;
