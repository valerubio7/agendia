import { cleanup, reportFailure } from './main.mjs';

await cleanup(process.env.STATE_directory).catch(reportFailure);
