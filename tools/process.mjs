import { startQqProvider, stopQqProvider, stopOwned } from '../src/processes.js';
try {
 if(process.argv[2]==='start') console.log(await startQqProvider());
 else if(process.argv[2]==='stop') {console.log(await stopQqProvider());console.log(await stopOwned('server'));}
 else throw new Error('Usage: node tools/process.mjs start|stop');
} catch(error){console.error(error.message);process.exitCode=1;}
