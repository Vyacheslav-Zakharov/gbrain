import {readFileSync} from 'node:fs';
import {verifyRuntimeMarkers} from './markdown-projection-runtime-hosted';
const rows=readFileSync(process.argv[2],'utf8').split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
verifyRuntimeMarkers(rows);
console.log('runtime inventory passed');
