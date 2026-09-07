// eb/cli.js — drive the Enable Banking flow from the terminal.
//
//   node eb/cli.js application            # app metadata + registered redirects
//   node eb/cli.js aspsps [country] [q]   # list ASPSPs (default: config country)
//   node eb/cli.js jwt                    # print a fresh signed JWT (debug)
//   node eb/cli.js auth                   # start consent, print the bank URL
//   node eb/cli.js callback "<redirect-url>"   # finish: paste the URL you land on
//   node eb/cli.js refresh <session_id>   # re-pull balances + transactions
//
// Uses DB_PATH (default ./finance.db), same as the server.

import { openDb } from '../db.js';
import { EB } from './config.js';
import { getJwt } from './jwt.js';
import { listAspsps, getApplication } from './client.js';
import { migrate } from './store.js';
import { beginAuthorization, completeCallback, syncSession } from './flow.js';

const [cmd, ...args] = process.argv.slice(2);
const db = openDb(process.env.DB_PATH || './finance.db');
migrate(db.raw);
const pretty = (o) => console.log(JSON.stringify(o, null, 2));

try {
  switch (cmd) {
    case 'application':
      pretty(await getApplication());
      break;

    case 'aspsps': {
      const country = args[0] || EB.aspspCountry;
      const q = (args[1] || '').toLowerCase();
      const resp = await listAspsps({ country });
      let list = resp.aspsps || resp || [];
      if (q) list = list.filter((a) => String(a.name).toLowerCase().includes(q));
      pretty({ count: list.length, aspsps: list });
      break;
    }

    case 'jwt':
      console.log(getJwt());
      break;

    case 'auth': {
      const { url, state, authorization_id } = await beginAuthorization(db.raw);
      console.log('\nOpen this URL in a browser and approve the sandbox consent:\n');
      console.log('  ' + url + '\n');
      console.log('state:', state);
      console.log('authorization_id:', authorization_id);
      console.log('\nAfter you are redirected, run:');
      console.log('  node eb/cli.js callback "<the full URL you land on>"\n');
      break;
    }

    case 'callback': {
      if (!args[0]) throw new Error('pass the full redirect URL you landed on');
      const u = new URL(args[0]);
      const summary = await completeCallback(db.raw, {
        code: u.searchParams.get('code'),
        state: u.searchParams.get('state'),
      });
      console.log('\nSynced from sandbox:\n');
      pretty(summary);
      break;
    }

    case 'refresh': {
      if (!args[0]) throw new Error('pass a session_id');
      pretty(await syncSession(db.raw, args[0]));
      break;
    }

    default:
      console.log('commands: application | aspsps | jwt | auth | callback | refresh');
  }
} finally {
  db.close();
}
