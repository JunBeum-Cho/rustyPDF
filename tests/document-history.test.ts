import test from "node:test";
import assert from "node:assert/strict";
import { setDocumentStore, activeTab, emptyAnnotationTabState, type Tab } from "../src/state/document";
import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {window:dom.window,document:dom.window.document});
const { recordAnnotationHistory, addAnnotation, addAnnotationToTab } = await import("../src/annotations/store");
import { snapshotPageEdit, commitPageEditHistory } from "../src/viewer/documentHistoryState";
const { canUndoDocumentEdit, canRedoDocumentEdit, undoDocumentEdit, redoDocumentEdit, historyBusy } = await import("../src/viewer/documentHistory");
const { enqueueDocumentMutation, registerPreMutationHook } = await import("../src/ipc/documentMutations");
import { setDesktopForTests } from "../src/platform/desktop";
const page = {index:0,width:200,height:300,rotation:0 as const};
const annotation = {id:"text",page:0,type:"text",rect:{x:1,y:2,w:30,h:40},style:{},payload:{text:"editable"}};
function reset() {
 const tab = {tabId:"a",docId:"doc",revision:1,path:"/tmp/a.pdf",pageCount:2,pages:[page,{...page,index:1}],fileSize:10,contentVersion:0,zoom:1,currentPage:0,navigationVersion:0,selectedPageIndices:[0],pageAnchor:0,pageDirty:false,annotations:emptyAnnotationTabState(),readOnly:false,readOnlyReason:null,signed:false,formDirty:false} as Tab;
 setDocumentStore({tabs:[tab],activeTabId:"a"});
}
const restoreResult = (revision:number) => ({id:"doc",revision,pageCount:2,pages:[page,{...page,index:1}],fileSize:10,retainedHistoryTokens:["token"]});

test("undo walks page then annotation entries in one stack; redo returns", async () => {
 reset();
 addAnnotation(annotation as any);                       // entry 1: annotation (items [])
 const before = snapshotPageEdit(activeTab()!);           // items [annotation]
 setDocumentStore("tabs",0,"annotations","items",[]);     // page edit removed it
 commitPageEditHistory("a",before,{historyToken:"token",retainedHistoryTokens:["token"]});
 let rev=1; const calls:any[]=[];
 setDesktopForTests({invoke:async (command:string,args:any) => {if(command==="pdf_restore_snapshot") calls.push([command,args]); return restoreResult(++rev);}} as any);
 assert.equal(canUndoDocumentEdit(),true);
 await undoDocumentEdit();
 assert.deepEqual(calls[0],["pdf_restore_snapshot",{docId:"doc",expectedRevision:1,token:"token"}]);
 assert.equal(activeTab()!.annotations.items[0].payload!.text,"editable");
 assert.equal(activeTab()!.selectedPageIndices[0],0);
 assert.equal(activeTab()!.pageDirty,true);
 assert.equal(activeTab()!.revision,2);
 await undoDocumentEdit();                                // annotation entry, no IPC
 assert.equal(calls.length,1);
 assert.equal(activeTab()!.annotations.items.length,0);
 await redoDocumentEdit();
 assert.equal(activeTab()!.annotations.items.length,1);
 await redoDocumentEdit();                                // page entry again
 assert.equal(calls.length,2);
 assert.equal(activeTab()!.annotations.items.length,0);
 assert.equal(canRedoDocumentEdit(),false);
 recordAnnotationHistory();
 assert.equal(canRedoDocumentEdit(),false);
 setDesktopForTests(null);
});

test("annotation edits during a page restore are ignored", async () => {
 reset();
 commitPageEditHistory("a",snapshotPageEdit(activeTab()!),{historyToken:"token",retainedHistoryTokens:["token"]});
 let finish!: (value: unknown)=>void; let started!: ()=>void;
 const ready = new Promise<void>(resolve=>started=resolve);
 setDesktopForTests({invoke:async () => {started(); return new Promise(resolve=>finish=resolve);}} as any);
 const undo = undoDocumentEdit();
 await ready;
 assert.equal(historyBusy(),true);
 addAnnotation(annotation as any);
 assert.equal(addAnnotationToTab("a",{...annotation,id:"other"} as any),false);
 assert.equal(activeTab()!.annotations.items.length,0);
 finish(restoreResult(2));
 await undo;
 assert.equal(historyBusy(),false);
 assert.equal(activeTab()!.annotations.items.length,0);
 assert.equal(activeTab()!.editFuture!.length,1);
 addAnnotation(annotation as any);
 assert.equal(activeTab()!.annotations.items.length,1);
 setDesktopForTests(null);
});

test("history keeps at most 80 entries", () => {
 reset();
 for (let i=0;i<85;i++) addAnnotation({...annotation,id:`n${i}`} as any);
 assert.equal(activeTab()!.editHistory!.length,80);
 for (let i=0;i<85;i++) commitPageEditHistory("a",snapshotPageEdit(activeTab()!),{historyToken:`t${i}`,retainedHistoryTokens:Array.from({length:i+1},(_,k)=>`t${k}`)});
 assert.equal(activeTab()!.editHistory!.length,80);
});

test("failed page restore does not consume ordered history", async () => {
 reset();
 commitPageEditHistory("a",snapshotPageEdit(activeTab()!),{historyToken:"token",retainedHistoryTokens:["token"]});
 setDesktopForTests({invoke:async () => {throw new Error("Stale document revision");}} as any);
 await undoDocumentEdit();
 assert.equal(activeTab()!.editHistory!.length,1);
 assert.equal(activeTab()!.revision,1);
 assert.equal(canRedoDocumentEdit(),false);
 assert.equal(historyBusy(),false);
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

test("addAnnotationToTab records history on that tab", () => {
 reset();
 assert.equal(addAnnotationToTab("a",annotation as any),true);
 assert.equal(addAnnotationToTab("missing",annotation as any),false);
 assert.equal(activeTab()!.annotations.dirty,true);
 assert.deepEqual(activeTab()!.editHistory!.map(e=>e.kind),["annotation"]);
});

test("pre-mutation hooks run before the queued task and can be removed", async () => {
 reset();
 const order:string[]=[];
 const off = registerPreMutationHook(async tabId => {order.push(`hook:${tabId}`);});
 await enqueueDocumentMutation("a",async()=>{order.push("task");});
 off();
 await enqueueDocumentMutation("a",async()=>{order.push("task2");});
 assert.deepEqual(order,["hook:a","task","task2"]);
});
