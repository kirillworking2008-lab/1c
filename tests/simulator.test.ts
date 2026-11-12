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
