// Optional: populate finance.db with sample data for a quick look.
//   node seed-demo.js            (uses ./finance.db)
//   DB_PATH=./demo.db node seed-demo.js
import { openDb } from './db.js';
import { today, addDays } from './dates.js';

const db = openDb(process.env.DB_PATH || './finance.db');
const t = today();

const E = (o) => db.createEntry(o);

// income
E({ amount: 2650, type: 'income', date: addDays(t, -1), account: 'Bank', title: 'Salary' });
E({ amount: 60, type: 'income', date: t, account: 'Revolut', title: 'Sold headphones' });
E({ amount: 120, type: 'income', date: addDays(t, -12), account: 'Revolut', title: 'Refund' });
E({ amount: 400, type: 'income', date: addDays(t, -40), account: 'Bank', title: 'Freelance' });

// this-week expenses
E({ amount: 54.2, type: 'expense', date: addDays(t, -1), account: 'Revolut', category: 'Discretionary', title: 'Groceries' });
E({ amount: 12.5, type: 'expense', date: t, account: 'Cash', category: 'Discretionary', title: 'Lunch' });
E({ amount: 300, type: 'expense', date: addDays(t, -2), account: 'Bank', category: 'Savings', title: 'Savings transfer' });
E({ amount: 250, type: 'expense', date: addDays(t, -2), account: 'Bank', category: 'Investments', title: 'Index fund' });

// earlier this month
E({ amount: 46.99, type: 'expense', date: addDays(t, -9), account: 'Revolut', category: 'Discretionary', title: 'Restaurant' });
E({ amount: 80, type: 'expense', date: addDays(t, -14), account: 'Cash', category: 'Discretionary', title: 'Concert' });
E({ amount: 200, type: 'expense', date: addDays(t, -16), account: 'Bank', category: 'Savings' });

// last month (for comparisons)
E({ amount: 61, type: 'expense', date: addDays(t, -34), account: 'Revolut', category: 'Discretionary', title: 'Groceries' });
E({ amount: 400, type: 'expense', date: addDays(t, -35), account: 'Bank', category: 'Investments' });

// recurring
db.createRule({ amount: 34.99, type: 'expense', account: 'Bank', category: 'Discretionary', title: 'Gym membership', interval: 'monthly', start_date: addDays(t, -70) });
db.createRule({ amount: 12.99, type: 'expense', account: 'Revolut', category: 'Discretionary', title: 'Streaming', interval: 'monthly', start_date: addDays(t, -40) });
db.createRule({ amount: 3.5, type: 'expense', account: 'Revolut', category: 'Discretionary', title: 'Cloud storage', interval: 'weekly', start_date: addDays(t, -21) });

console.log('seeded', db.listEntries().length, 'entries and', db.listRules().length, 'recurring rules');
db.close();
