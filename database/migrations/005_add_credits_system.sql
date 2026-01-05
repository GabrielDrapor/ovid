-- Migration: Add credits system for Stripe payments
-- Users get 1000 credits on signup, can purchase more via Stripe

-- Add credits column to users table (default 1000 for welcome gift)
ALTER TABLE users ADD COLUMN credits INTEGER NOT NULL DEFAULT 1000;

-- Create credit_transactions table to track all credit changes
CREATE TABLE IF NOT EXISTS credit_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,  -- positive for purchases, negative for usage
    type TEXT NOT NULL,  -- 'signup_bonus', 'purchase', 'usage', 'refund'
    description TEXT,
    stripe_payment_intent_id TEXT,  -- for purchases via Stripe
    book_uuid TEXT,  -- for usage transactions (which book consumed credits)
    balance_after INTEGER NOT NULL,  -- user's credit balance after this transaction
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);

-- Indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_credit_transactions_user ON credit_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_type ON credit_transactions(type);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_stripe ON credit_transactions(stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_credit_transactions_created ON credit_transactions(created_at);
