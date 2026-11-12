import { z } from 'zod';
import { InfobaseState } from '../types/oneC';
import { rebuildAllRegisters } from './accountingEngine';

const text = z.string();
const num = z.number().finite();
const base = {id:text, code:text};
const attr = z.object({name:text,type:z.enum(['Строка','Число','Дата','Булево','СправочникСсылка'])});
const line = z.object({id:text,nomenclatureId:text,nomenclatureName:text,quantity:num,price:num,amount:num,vatRate:z.enum(['20%','10%','Без НДС']),vatAmount:num,total:num,accountCode:text});
const manual = z.object({id:text,debitAccount:text,debitSubconto:text,creditAccount:text,creditSubconto:text,amount:num,content:text});
const docType = z.enum(['ПоступлениеТоваровУслуг','РеализацияТоваровУслуг','ПриходныйКассовыйОрдер','РасходныйКассовыйОрдер','ПоступлениеНаРасчетныйСчет','СписаниеСРасчетногоСчета','НачислениеЗарплаты','ОперацияБух']);
const schema = z.object({
 version:text,infobaseName:text,currentUser:text,
 organizations:z.array(z.object({...base,name:text,fullName:text,inn:text,kpp:text,taxSystem:z.enum(['ОСНО','УСН (Доходы 6%)','УСН (Доходы-Расходы 15%)'])})),
 counterparties:z.array(z.object({...base,name:text,inn:text,kpp:text,type:z.enum(['Юридическое лицо','Физическое лицо','ИП']),role:z.enum(['Покупатель','Поставщик','Прочее']),phone:text,contract:text})),
 nomenclature:z.array(z.object({...base,article:text,name:text,type:z.enum(['Товар','Услуга','Материал']),unit:z.enum(['шт','усл','кг','компл','мес']),vatRate:z.enum(['20%','10%','Без НДС']),purchasePrice:num,salePrice:num,accountCode:text})),
 warehouses:z.array(z.object({...base,name:text,type:z.enum(['Оптовый склад','Розничный магазин']),responsible:text})),
 employees:z.array(z.object({...base,fullName:text,position:text,department:text,salary:num,inn:text,hireDate:text})),
 chartOfAccounts:z.array(z.object({code:text,name:text,kind:z.enum(['Активный','Пассивный','Активно-пассивный']),subconto1:text.optional(),subconto2:text.optional(),isQuantitative:z.boolean().optional()})),
 documents:z.array(z.object({id:text,docType,number:text,date:text,posted:z.boolean(),markedForDeletion:z.boolean(),organizationId:text,counterpartyId:text.optional(),warehouseId:text.optional(),employeeId:text.optional(),amount:num,vatAmount:num,comment:text,cashFlowArticle:text.optional(),lines:z.array(line),manualEntries:z.array(manual).optional()})),
 modules:z.array(z.object({id:text,objectType:z.enum(['ОбщийМодуль','Справочник','Документ','Обработка','Отчет']),objectName:text,moduleType:z.enum(['МодульОбъекта','МодульМенеджера','МодульФормы','МодульКоманды','ОбщийМодуль']),title:text,code:text,readOnly:z.boolean().optional()})),
 customCatalogs:z.array(z.object({name:text,synonym:text,attributes:z.array(attr)})),customDocuments:z.array(z.object({name:text,synonym:text,attributes:z.array(attr),postingCode:text})),
 completedTaskIds:z.array(text),xpTotal:num,messageLog:z.array(z.object({id:text,time:text,text,type:z.enum(['info','warning','error','success'])})),
});

/** Only the simulator's own JSON format is accepted, never a 1C .dt file. */
export function restoreBackup(contents:string):InfobaseState {
 const json:unknown=JSON.parse(contents);
 const envelope=z.object({format:z.literal('learning-1c-backup'),formatVersion:z.literal(1),data:schema}).parse(json);
 const state={...envelope.data,accountingEntries:[],stockMovements:[]} as InfobaseState;
 return {...state,...rebuildAllRegisters(state)};
}
export function serializeBackup(state:InfobaseState):string {
 return JSON.stringify({format:'learning-1c-backup',formatVersion:1,data:state},null,2);
}
