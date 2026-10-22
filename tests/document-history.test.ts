import test from "node:test";
import assert from "node:assert/strict";
import { setDocumentStore, activeTab, emptyAnnotationTabState, type Tab } from "../src/state/document";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {window:dom.window,document:dom.window.document});
const { recordAnnotationHistory, undoAnnotations } = await import("../src/annotations/store");
import { snapshotPageEdit, commitPageEditHistory } from "../src/viewer/documentHistoryState";
const { canUndoDocumentEdit, canRedoDocumentEdit, undoDocumentEdit, redoDocumentEdit } = await import("../src/viewer/documentHistory");
import { setDesktopForTests } from "../src/platform/desktop";
const page = {index:0,width:200,height:300,rotation:0 as const};
const annotation = {id:"text",page:0,type:"text",rect:{x:1,y:2,w:30,h:40},style:{},payload:{text:"editable"}};
function reset() {
 const tab = {tabId:"a",docId:"doc",revision:1,path:"/tmp/a.pdf",annotationDocumentKey:"key",pageCount:2,pages:[page,{...page,index:1}],fileSize:10,contentVersion:0,zoom:1,rotation:0,currentPage:0,navigationVersion:0,selectedPageIndices:[0],pageAnchor:0,pageDirty:false,annotations:emptyAnnotationTabState()} as Tab;
 setDocumentStore({tabs:[tab],activeTabId:"a"});
}
test("page boundary restores editable annotation and its earlier undo; redo and divergent edits", async () => {
 reset();
 recordAnnotationHistory();
 setDocumentStore("tabs",0,"annotations","items",[annotation as any]);
 const before = snapshotPageEdit(activeTab()!);
 setDocumentStore("tabs",0,"annotations",emptyAnnotationTabState());
 setDocumentStore("tabs",0,"pageCount",1);
 commitPageEditHistory("a",before,{historyToken:"token",retainedHistoryTokens:["token"]});
 let rev=1;
 setDesktopForTests({invoke:async () => ({id:"doc",revision:++rev,pageCount:rev%2?1:2,pages:[page],fileSize:10,retainedHistoryTokens:["token"]})} as any);
 assert.equal(canUndoDocumentEdit(),true);
 await undoDocumentEdit();
 assert.equal(activeTab()!.annotations.items[0].payload!.text,"editable");
 assert.equal(activeTab()!.selectedPageIndices[0],0);
 assert.equal(activeTab()!.pageDirty,true);
 await undoDocumentEdit();
 assert.equal(activeTab()!.annotations.items.length,0);
 await redoDocumentEdit();
 await redoDocumentEdit();
 assert.equal(activeTab()!.annotations.items.length,0);
 await undoDocumentEdit();
 recordAnnotationHistory();
 assert.equal(canRedoDocumentEdit(),false);
 undoAnnotations();
 setDesktopForTests(null);
});

test("failed page restore does not consume ordered history", async () => {
 reset();
 commitPageEditHistory("a",snapshotPageEdit(activeTab()!),{historyToken:"token",retainedHistoryTokens:["token"]});
 setDesktopForTests({invoke:async () => {throw new Error("Stale document revision");}} as any);
 await undoDocumentEdit();
 assert.equal(activeTab()!.editHistory!.length,1);
 assert.equal(activeTab()!.revision,1);
 assert.equal(canRedoDocumentEdit(),false);
 setDesktopForTests(null);
});

test("eviction removes inaccessible boundary but preserves later annotation undo and other tabs", () => {
 reset();
 recordAnnotationHistory();
 commitPageEditHistory("a",snapshotPageEdit(activeTab()!),{historyToken:"old",retainedHistoryTokens:["old"]});
 recordAnnotationHistory();
 const b = {...JSON.parse(JSON.stringify(activeTab()!)),tabId:"b"};
 setDocumentStore("tabs",tabs => [...tabs,b]);
 commitPageEditHistory("a",snapshotPageEdit(activeTab()!),{historyToken:"new",retainedHistoryTokens:["new"]});
 assert.deepEqual(activeTab()!.editHistory!.map(e=>e.kind),["annotation","page"]);
 assert.equal((activeTab()!.editHistory![1] as any).token,"new");
 assert.equal(b.editHistory.length,3);
});

test("oversized snapshot immediately evicts its page boundary and explains unavailable undo", async () => {
 const { setToastEmitter } = await import("../src/capture/capture");
 const messages: string[]=[];
 setToastEmitter(event=>messages.push(event.message));
 reset();
 commitPageEditHistory("a",snapshotPageEdit(activeTab()!),{historyToken:"large",retainedHistoryTokens:[]});
 assert.equal(canUndoDocumentEdit(),false);
 assert.match(messages[0],/문서가 커서/);
 setToastEmitter(null);
});

test("queued delete includes annotation edits made while backend response is pending", async () => {
 const { register } = await import("node:module");
 register(`data:text/javascript,${encodeURIComponent('export async function load(url, context, nextLoad) { return url.endsWith(".css") ? { format:"module",source:"",shortCircuit:true } : nextLoad(url,context); }')}`,import.meta.url);
 const {deleteSelectedPages} = await import("../src/viewer/pageClipboard");
 reset();
 let finish!: (value: unknown)=>void;
 let started!: ()=>void;
 const ready = new Promise<void>(resolve=>started=resolve);
 let revision=1;
 setDesktopForTests({invoke:async (command:string) => {
   if(command === "pdf_delete_pages") {started(); return new Promise(resolve=>finish=resolve);}
   if(command === "pdf_restore_snapshot") return {id:"doc",revision:++revision,pageCount:2,pages:[page,{...page,index:1}],fileSize:10,retainedHistoryTokens:["delete"]};
   throw new Error(command);
 }} as any);
 const deletion=deleteSelectedPages();
 await ready;
 recordAnnotationHistory();
 setDocumentStore("tabs",0,"annotations","items",[annotation as any]);
 finish({id:"doc",revision:2,path:"/tmp/a.pdf",pageCount:1,pages:[page],fileSize:10,pageMapping:[null,0],historyToken:"delete",retainedHistoryTokens:["delete"]});
 await deletion;
 revision=2;
 assert.equal(activeTab()!.annotations.items.length,0);
 await undoDocumentEdit();
 assert.equal(activeTab()!.annotations.items[0].payload!.text,"editable");
 await undoDocumentEdit();
 assert.equal(activeTab()!.annotations.items.length,0);
 setDesktopForTests(null);
});

test("rotation undo restores annotation geometry and previous history across save", async () => {
 const {rotateDocument} = await import("../src/viewer/pageRotation");
 reset();
 recordAnnotationHistory();
 setDocumentStore("tabs",0,"annotations","items",[annotation as any]);
 const original = JSON.parse(JSON.stringify(activeTab()!.annotations.items));
 let revision=1;
 setDesktopForTests({invoke:async (command:string) => ({id:"doc",revision:++revision,path:"/tmp/a.pdf",pageCount:2,pages: command === "pdf_rotate_pages" ? [{...page,width:300,height:200,rotation:90},{...page,index:1,width:300,height:200,rotation:90}] : [page,{...page,index:1}],fileSize:10,historyToken:"rotate",retainedHistoryTokens:["rotate"]})} as any);
 await rotateDocument(1);
 assert.notDeepEqual(activeTab()!.annotations.items,original);
 // A save changes the current path/revision but preserves history tokens.
 setDocumentStore("tabs",0,"path","/tmp/saved-as.pdf");
 setDocumentStore("tabs",0,"pageDirty",false);
 setDocumentStore("tabs",0,"annotations","dirty",false);
 await undoDocumentEdit();
 assert.deepEqual(JSON.parse(JSON.stringify(activeTab()!.annotations.items)),original);
 assert.equal(activeTab()!.path,"/tmp/saved-as.pdf");
 assert.equal(activeTab()!.pageDirty,true);
 assert.equal(activeTab()!.annotations.dirty,true);
 await undoDocumentEdit();
 assert.equal(activeTab()!.annotations.items.length,0);
 setDesktopForTests(null);
});

test("annotation edits during asynchronous undo cancel restore without losing new edits", async () => {
 reset();
 commitPageEditHistory("a",snapshotPageEdit(activeTab()!),{historyToken:"undo",retainedHistoryTokens:["undo"]});
 let finish!: (value: unknown)=>void;
 let started!: ()=>void;
 const ready = new Promise<void>(resolve=>started=resolve);
 let calls=0;
 setDesktopForTests({invoke:async () => {
   calls++;
   if(calls === 1) {started();return new Promise(resolve=>finish=resolve);}
   return {id:"doc",revision:3,pageCount:2,pages:[page,{...page,index:1}],fileSize:10,retainedHistoryTokens:["undo"]};
 }} as any);
 const undo = undoDocumentEdit();
 await ready;
 const {addAnnotation} = await import("../src/annotations/store");
 addAnnotation(annotation as any);
 finish({id:"doc",revision:2,pageCount:2,pages:[page,{...page,index:1}],fileSize:10,retainedHistoryTokens:["undo"]});
 await undo;
 assert.equal(calls,2);
 assert.equal(activeTab()!.revision,3);
 assert.equal(activeTab()!.annotations.items[0].payload!.text,"editable");
 assert.equal(activeTab()!.editHistory!.length,2);
 assert.equal(canRedoDocumentEdit(),false);
 setDesktopForTests(null);
});

test("persistent compensation failure retains edits and blocks later mutations until recovery", async () => {
 reset();
 commitPageEditHistory("a",snapshotPageEdit(activeTab()!),{historyToken:"undo",retainedHistoryTokens:["undo"]});
 let finish!: (value: unknown)=>void;
 let started!: ()=>void;
 const ready = new Promise<void>(resolve=>started=resolve);
 let calls=0, failRecovery=true;
 setDesktopForTests({invoke:async () => {
   calls++;
   if(calls === 1) {started();return new Promise(resolve=>finish=resolve);}
   if(failRecovery) throw new Error("temporary bridge failure");
   return {id:"doc",revision:3,pageCount:2,pages:[page,{...page,index:1}],fileSize:10,retainedHistoryTokens:["undo"]};
 }} as any);
 const undo = undoDocumentEdit();
 await ready;
 const {addAnnotation} = await import("../src/annotations/store");
 addAnnotation(annotation as any);
 finish({id:"doc",revision:2,pageCount:2,pages:[page,{...page,index:1}],fileSize:10,retainedHistoryTokens:["undo"]});
 await undo;
 assert.equal(calls,3);
 assert.equal(activeTab()!.annotations.items[0].payload!.text,"editable");
 const {enqueueDocumentMutation} = await import("../src/ipc/documentMutations");
 let ran=false;
 await assert.rejects(enqueueDocumentMutation("a", async()=> {ran=true;}), /bridge failure/);
 assert.equal(ran,false);
 failRecovery=false;
 await enqueueDocumentMutation("a",async()=> {ran=true;});
 assert.equal(ran,true);
 assert.equal(activeTab()!.revision,3);
 assert.equal(activeTab()!.annotations.items[0].payload!.text,"editable");
 setDesktopForTests(null);
});

test("closing a document releases pending compensation without blocking mutation wait", async () => {
 const {setDocumentHistoryRecovery} = await import("../src/viewer/documentHistoryRecovery");
 const {invoke} = await import("../src/platform/desktop");
 const {enqueueDocumentMutation,waitForDocumentMutations} = await import("../src/ipc/documentMutations");
 let calls=0;
 setDocumentHistoryRecovery("closed", async()=>{calls++;throw new Error("closed");}, "closed-doc");
 setDesktopForTests({invoke:async()=>undefined} as any);
 await invoke("pdf_close",{docId:"closed-doc"});
 await enqueueDocumentMutation("closed",async()=>undefined);
 await waitForDocumentMutations("closed");
 assert.equal(calls,0);
 setDesktopForTests(null);
});

test("annotation during restore rolls back via transaction even after its history token is evicted", async () => {
 reset();
 commitPageEditHistory("a",snapshotPageEdit(activeTab()!),{historyToken:"evicted",retainedHistoryTokens:["evicted"]});
 let finish!: (value: unknown)=>void;
 let started!: ()=>void;
 const ready=new Promise<void>(resolve=>started=resolve);
 const commands:string[]=[];
 setDesktopForTests({invoke:async(command:string,args:any)=>{
  commands.push(command);
  if(command==="pdf_restore_snapshot") {assert.equal(args.transactional,true);started();return new Promise(resolve=>finish=resolve);}
  assert.equal(command,"pdf_rollback_restore");
  assert.equal(args.restoreTransaction,"transaction");
  return {id:"doc",revision:3,pageCount:2,pages:[page,{...page,index:1}],fileSize:10,retainedHistoryTokens:["evicted"]};
 }} as any);
 const undo=undoDocumentEdit();
 await ready;
 const {addAnnotation}=await import("../src/annotations/store");
 addAnnotation(annotation as any);
 finish({id:"doc",revision:2,pageCount:2,pages:[page,{...page,index:1}],fileSize:10,retainedHistoryTokens:[],restoreTransaction:"transaction"});
 await undo;
 assert.deepEqual(commands,["pdf_restore_snapshot","pdf_rollback_restore"]);
 assert.equal(activeTab()!.revision,3);
 assert.equal(activeTab()!.annotations.items[0].payload!.text,"editable");
 setDesktopForTests(null);
});

test("failed restore acceptance blocks later edits until acknowledgement succeeds", async () => {
 reset();
 commitPageEditHistory("a",snapshotPageEdit(activeTab()!),{historyToken:"token",retainedHistoryTokens:["token"]});
 let fail=true,acceptCalls=0;
 setDesktopForTests({invoke:async(command:string)=>{
  if(command==="pdf_restore_snapshot") return {id:"doc",revision:2,pageCount:2,pages:[page],fileSize:10,retainedHistoryTokens:["token"],restoreTransaction:"transaction"};
  assert.equal(command,"pdf_accept_restore");
  acceptCalls++;
  if(fail) throw new Error("acknowledgement failed");
 }} as any);
 await undoDocumentEdit();
 assert.equal(acceptCalls,2);
 assert.equal(activeTab()!.revision,2);
 const {enqueueDocumentMutation}=await import("../src/ipc/documentMutations");
 let ran=false;
 await assert.rejects(enqueueDocumentMutation("a",async()=>{ran=true;}),/acknowledgement/);
 assert.equal(ran,false);
 fail=false;
 await enqueueDocumentMutation("a",async()=>{ran=true;});
 assert.equal(ran,true);
 setDesktopForTests(null);
});
