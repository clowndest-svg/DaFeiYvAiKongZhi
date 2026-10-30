import { startNapCat, stopOwned } from '../src/processes.js';
try {
 if(process.argv[2]==='start') console.log(await startNapCat());
 else if(process.argv[2]==='stop') {console.log(await stopOwned('napcat'));console.log(await stopOwned('server'));}
 else throw new Error('Usage: node tools/process.mjs start|stop');
} catch(error){console.error(error.message);process.exitCode=1;}
