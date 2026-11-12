import { test } from 'node:test';
import assert from 'node:assert/strict';
import {createInitialInfobase} from '../src/data/initialData';
import {rebuildAllRegisters, generateMovementsForDocument} from '../src/engine/accountingEngine';
import {restoreBackup, serializeBackup} from '../src/engine/backup';
import {executeBSLCode} from '../src/engine/bslInterpreter';
import {execute1CQuery} from '../src/engine/queryEngine1C';

const state=()=>{const s=createInitialInfobase();return {...s,...rebuildAllRegisters(s)};};
test('backup restores state and rebuilds registers, rejecting incompatible data',()=>{
 const s=state(); const restored=restoreBackup(serializeBackup(s));
 assert.equal(restored.documents.length,s.documents.length); assert.deepEqual(restored.accountingEntries,s.accountingEntries);
 assert.throws(()=>restoreBackup('{}'));
 const tampered=JSON.parse(serializeBackup(s)); tampered.data.documents[0].docType='unknown';
 assert.throws(()=>restoreBackup(JSON.stringify(tampered)));
});
test('query reads demo nomenclature',()=>{
 const result=execute1CQuery('ВЫБРАТЬ Наименование, ЦенаПродажи ИЗ Справочник.Номенклатура ГДЕ ЦенаПродажи > 20000',state());
 assert.equal(result.error,undefined); assert.equal(result.rows.length,2);
});
test('while cursor processes first row too',()=>{
 const result=executeBSLCode('Запрос = Новый Запрос; Запрос.Текст = "ВЫБРАТЬ ФИО ИЗ Справочник.Сотрудники"; Выборка = Запрос.Выполнить().Выбрать(); Пока Выборка.Следующий() Цикл Сообщить(Выборка.ФИО); КонецЦикла;',state());
 assert.equal(result.success,true,result.error); assert.equal(result.output.length,3);
});
test('posting rejects insufficient stock across repeated lines',()=>{
 const s=state(); const initial=s.documents.find(d=>d.docType==='РеализацияТоваровУслуг')!; const first=initial.lines[0];
 const doc={...initial,id:'test',lines:[{...first,quantity:4},{...first,id:'other',quantity:4}]};
 const result=generateMovementsForDocument(doc,s,s.stockMovements,true);assert.equal(result.ok,false);assert.equal(result.entries.length,0);
});

test('query handles Cyrillic parameters, quoted logical words and parentheses',()=>{
 const s=state();
 const q=execute1CQuery('ВЫБРАТЬ Наименование ИЗ Справочник.Номенклатура ГДЕ (ЦенаПродажи > &Цена И ЦенаПродажи < 70000) ИЛИ Наименование = "не И не"',s,{Цена:20000});
 assert.equal(q.error,undefined);assert.equal(q.rows.length,2);
 const like=execute1CQuery('ВЫБРАТЬ Наименование ИЗ Справочник.Контрагенты ГДЕ Наименование ПОДОБНО "АО%"',s);
 assert.equal(like.rows.length,1);
});
test('query does not silently ignore unsupported virtual table parameters or unknown fields',()=>{
 const s=state();assert.match(execute1CQuery('ВЫБРАТЬ Неизвестное ИЗ Справочник.Номенклатура',s).error || '',/Поле не найдено/);
 assert.match(execute1CQuery('ВЫБРАТЬ Склад ИЗ РегистрНакопления.ТоварыНаСкладах.Остатки(&Дата)',s).error || '',/параметры/i);
});
test('cancelling a receipt cannot invalidate later sales',async()=>{
 const {rebuildRegistersChecked}=await import('../src/engine/accountingEngine');const s=state();
 const modified={...s,documents:s.documents.map(d=>d.id==='doc-buy-1'?{...d,posted:false}:d)};
 const result=rebuildRegistersChecked(modified); assert.equal(result.ok,false);
});
test('OSV uses non-negative debit and credit columns and preserves double entry',async()=>{
 const {buildOSVReport}=await import('../src/engine/accountingEngine');const s=state(); const report=buildOSVReport(s.chartOfAccounts,s.accountingEntries);
 assert.equal(report.totals.turnDebit,report.totals.turnCredit);
 assert.ok(report.rows.every(r=>r.closeDebit>=0&&r.closeCredit>=0));
 assert.equal(report.totals.closeDebit,report.totals.closeCredit);
});
test('all lesson starter examples execute and pass their checks',async()=>{
 const {ACADEMY_TASKS,validateAcademyTask}=await import('../src/data/academyTasks');const s=state();
 for(const task of ACADEMY_TASKS){
   if(task.starterQuery){const r=execute1CQuery(task.starterQuery,s);assert.equal(r.error,undefined,task.title);assert.equal(validateAcademyTask(task,{state:s,lastQueryResult:r,lastQueryText:task.starterQuery,lastBSLResult:null,lastBSLCode:''}).passed,true,task.title);}
   if(task.starterCode){const r=executeBSLCode(task.starterCode,s);assert.equal(r.success,true,`${task.title}: ${r.error}`);assert.equal(validateAcademyTask(task,{state:s,lastQueryResult:null,lastQueryText:'',lastBSLResult:r,lastBSLCode:task.starterCode}).passed,true,task.title);}
 }
});
