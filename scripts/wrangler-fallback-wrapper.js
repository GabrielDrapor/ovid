#!/usr/bin/env node

/**
 * Wrapper for wrangler d1 execute that falls back to better-sqlite3
 * when workerd fails to start
 * 
 * Usage: node wrangler-fallback-wrapper.js [wrangler args...]
 */

const { execSync } = require('child_process');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);

// Parse wrangler d1 execute command
// Looking for patterns like: npx wrangler d1 execute ovid-db --local --file=schema.sql
//                        or: npx wrangler d1 execute ovid-db --local --command "SELECT 1;"

function runWithFallback() {
  const isSqlFile = args.some(arg => arg.includes('--file='));
  const isCommand = args.some(arg => arg.includes('--command'));

  if (!isSqlFile && !isCommand) {
    console.error('❌ Expected --file or --command argument');
    process.exit(1);
  }

  // Try wrangler first
  try {
    console.log('🔧 Attempting wrangler d1 execute...');
    const cmd = `npx wrangler d1 execute ${args.join(' ')}`;
    execSync(cmd, { stdio: 'inherit' });
    console.log('✅ Wrangler succeeded');
    return;
  } catch (e) {
    console.log('⚠️  Wrangler failed:', e.message.split('\n')[0]);
    console.log('🔄 Falling back to direct SQLite...');
  }

  // Extract SQL from arguments
  let sqlToExecute = '';

  if (isSqlFile) {
    const fileIndex = args.findIndex(arg => arg.includes('--file='));
    const filePath = args[fileIndex].replace('--file=', '').replace(/^["']|["']$/g, '');
    const fullPath = path.resolve(process.cwd(), filePath);
    
    if (!fs.existsSync(fullPath)) {
      console.error(`❌ File not found: ${fullPath}`);
      process.exit(1);
    }
    
    sqlToExecute = fs.readFileSync(fullPath, 'utf-8');
    console.log(`📄 Executing SQL from file: ${filePath}`);
  } else if (isCommand) {
    const cmdIndex = args.findIndex(arg => arg.includes('--command'));
    const rawCmd = args[cmdIndex].replace('--command', '').trim();
    // Remove quotes if present
    sqlToExecute = rawCmd.replace(/^["']|["']$/g, '');
    console.log(`📝 Executing command: ${sqlToExecute.substring(0, 100)}...`);
  }

  // Connect to local SQLite database
  const dbPath = path.resolve(process.cwd(), '.wrangler/state/v3/d1/ovid-db.sqlite3');
  const dbDir = path.dirname(dbPath);

  // Ensure DB directory exists and DB is initialized
  if (!fs.existsSync(dbPath)) {
    console.log('📦 Initializing database...');
    fs.mkdirSync(dbDir, { recursive: true });
    
    const db = new Database(dbPath);
    const schemaPath = path.resolve(process.cwd(), 'database/schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schema = fs.readFileSync(schemaPath, 'utf-8');
      schema.split(';').forEach(stmt => {
        if (stmt.trim()) {
          try {
            db.exec(stmt);
          } catch (err) {
            if (!err.message.includes('already exists')) {
              console.warn('⚠️  Schema warning:', err.message);
            }
          }
        }
      });
    }
    db.close();
  }

  // Execute SQL
  try {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');

    // Split and execute statements
    const statements = sqlToExecute
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    console.log(`⚙️  Executing ${statements.length} SQL statement(s)...`);

    statements.forEach((stmt, idx) => {
      try {
        db.exec(stmt);
        // console.log(`  ✅ [${idx + 1}/${statements.length}] Success`);
      } catch (err) {
        // Some statements like CREATE TABLE IF NOT EXISTS might "fail" if table exists
        if (
          err.message.includes('already exists') ||
          err.message.includes('duplicate column') ||
          err.message.includes('UNIQUE constraint')
        ) {
          console.log(`  ℹ️  [${idx + 1}/${statements.length}] ${err.message}`);
        } else {
          console.error(`  ❌ [${idx + 1}/${statements.length}] Error:`, err.message);
          console.error('     Statement:', stmt.substring(0, 150));
          throw err;
        }
      }
    });

    db.close();
    console.log('✅ SQLite execution completed');
  } catch (err) {
    console.error('❌ SQLite fallback failed:', err.message);
    process.exit(1);
  }
}

runWithFallback();
