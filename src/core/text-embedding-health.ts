import type {BrainEngine} from './engine.ts';
import {selectedTextEngine,selectedTextColumn} from './selected-text-embedding.ts';
/** Health for the selected text vector space, excluding tombstoned pages. */
export async function embeddingHealth(engine:BrainEngine):Promise<{column:string,total:number,missing:number,coverage:number}>{
 const selected=await selectedTextEngine(engine);
 const column=selectedTextColumn(selected)?.name??'embedding';
 // selectedTextEngine validates the descriptor and identifier before this use.
 const identifier='"'+column.replace(/"/g,'""')+'"';
 const [row]=await engine.executeRaw<{total:number|string,missing:number|string}>(
  `SELECT COUNT(*) AS total,COUNT(*) FILTER (WHERE cc.${identifier} IS NULL) AS missing FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE p.deleted_at IS NULL`);
 const total=Number(row?.total??0),missing=Number(row?.missing??0);
 return {column,total,missing,coverage:total>0?(total-missing)/total:1};
}
