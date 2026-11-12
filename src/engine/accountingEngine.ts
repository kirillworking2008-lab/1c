import {
  AccountingEntry,
  ChartAccount,
  Doc1C,
  InfobaseState,
  StockMovement,
} from '../types/oneC';
import { DOC_TYPE_LABELS } from '../data/initialData';

export interface PostingResult {
  ok: boolean;
  errorMessage?: string;
  entries: AccountingEntry[];
  stockMovements: StockMovement[];
}

export function getDocPresentation(doc: Doc1C): string {
  const shortTitle = DOC_TYPE_LABELS[doc.docType]?.short || doc.docType;
  return `${shortTitle} № ${doc.number} от ${doc.date.slice(0, 10)}`;
}

/**
 * Рассчитывает остатки товаров на складах на момент времени (или в целом)
 */
export function calculateWarehouseBalances(
  movements: StockMovement[],
  excludeDocId?: string
): Map<string, { quantity: number; costAmount: number; warehouseName: string; nomenclatureName: string }> {
  const map = new Map<string, { quantity: number; costAmount: number; warehouseName: string; nomenclatureName: string }>();

  for (const m of movements) {
    if (excludeDocId && m.docId === excludeDocId) continue;
    const key = `${m.warehouseId}::${m.nomenclatureId}`;
    const prev = map.get(key) || {
      quantity: 0,
      costAmount: 0,
      warehouseName: m.warehouseName,
      nomenclatureName: m.nomenclatureName,
    };
    if (m.movementType === 'Приход') {
      prev.quantity += m.quantity;
      prev.costAmount += m.costAmount;
    } else {
      prev.quantity -= m.quantity;
      prev.costAmount -= m.costAmount;
    }
    map.set(key, prev);
  }
  return map;
}

/**
 * Генерирует проводки Дт/Кт и движения регистров для одного документа
 */
export function generateMovementsForDocument(
  doc: Doc1C,
  state: InfobaseState,
  existingStockMovements: StockMovement[],
  checkNegativeStock = true
): PostingResult {
  if (doc.markedForDeletion) {
    return {
      ok: false,
      errorMessage: `Нельзя провести документ "${getDocPresentation(doc)}", помеченный на удаление!`,
      entries: [],
      stockMovements: [],
    };
  }

  const entries: AccountingEntry[] = [];
  const stockMovements: StockMovement[] = [];
  const period = doc.date.slice(0, 10);
  const presentation = getDocPresentation(doc);

  const cp = state.counterparties.find((c) => c.id === doc.counterpartyId);
  const cpName = cp ? cp.name : 'Прочий контрагент';
  const wh = state.warehouses.find((w) => w.id === doc.warehouseId);
  const whName = wh ? wh.name : 'Основной склад';
  const emp = state.employees.find((e) => e.id === doc.employeeId);
  const empName = emp ? emp.fullName : 'Все сотрудники штата';

  let entryIdx = 1;
  const makeEntryId = () => `${doc.id}-ent-${entryIdx++}`;
  let stockIdx = 1;
  const makeStockId = () => `${doc.id}-stk-${stockIdx++}`;

  switch (doc.docType) {
    case 'ПоступлениеТоваровУслуг': {
      if (doc.lines.length === 0) {
        return { ok: false, errorMessage: 'Табличная часть "Товары/Услуги" пуста! Добавьте хотя бы одну строку.', entries: [], stockMovements: [] };
      }

      for (const line of doc.lines) {
        const nom = state.nomenclature.find((n) => n.id === line.nomenclatureId);
        const nomType = nom?.type || 'Товар';
        const acc = line.accountCode || (nomType === 'Материал' ? '10.01' : nomType === 'Услуга' ? '26' : '41.01');

        // 1. Приход на склад (если это товар или материал)
        if (nomType !== 'Услуга') {
          stockMovements.push({
            id: makeStockId(),
            docId: doc.id,
            docPresentation: presentation,
            period,
            movementType: 'Приход',
            warehouseId: doc.warehouseId || 'wh-1',
            warehouseName: whName,
            nomenclatureId: line.nomenclatureId,
            nomenclatureName: line.nomenclatureName,
            quantity: line.quantity,
            costAmount: line.amount,
          });
        }

        // 2. Проводка Дт 41.01 (10.01 / 26) — Кт 60.01 на сумму без НДС
        entries.push({
          id: makeEntryId(),
          docId: doc.id,
          docType: doc.docType,
          docPresentation: presentation,
          period,
          debitAccount: acc,
          debitSubconto1: line.nomenclatureName,
          debitSubconto2: nomType !== 'Услуга' ? whName : undefined,
          creditAccount: '60.01',
          creditSubconto1: cpName,
          creditSubconto2: cp?.contract,
          quantityDebit: nomType !== 'Услуга' ? line.quantity : undefined,
          amount: Number(line.amount.toFixed(2)),
          content: `Поступление: ${line.nomenclatureName}`,
        });

        // 3. Входящий НДС: Дт 19.03 (19.04) — Кт 60.01
        if (line.vatAmount > 0) {
          entries.push({
            id: makeEntryId(),
            docId: doc.id,
            docType: doc.docType,
            docPresentation: presentation,
            period,
            debitAccount: nomType === 'Услуга' ? '19.04' : '19.03',
            debitSubconto1: cpName,
            creditAccount: '60.01',
            creditSubconto1: cpName,
            amount: Number(line.vatAmount.toFixed(2)),
            content: `НДС предъявлен поставщиком (${line.vatRate})`,
          });
        }
      }
      break;
    }

    case 'РеализацияТоваровУслуг': {
      if (doc.lines.length === 0) {
        return { ok: false, errorMessage: 'Табличная часть "Товары и услуги" не заполнена!', entries: [], stockMovements: [] };
      }

      const balances = calculateWarehouseBalances(existingStockMovements, doc.id);

      for (const line of doc.lines) {
        const nom = state.nomenclature.find((n) => n.id === line.nomenclatureId);
        const nomType = nom?.type || 'Товар';
        const whId = doc.warehouseId || 'wh-1';

        if (nomType !== 'Услуга') {
          const key = `${whId}::${line.nomenclatureId}`;
          const bal = balances.get(key);
          const availQty = bal ? bal.quantity : 0;

          if (checkNegativeStock && availQty < line.quantity) {
            return {
              ok: false,
              errorMessage: `Не удалось провести "${presentation}"!\nНедостаточно товара "${line.nomenclatureName}" на складе "${whName}".\nТребуется: ${line.quantity}, в наличии: ${availQty}.`,
              entries: [],
              stockMovements: [],
            };
          }

          // Средняя себестоимость единицы
          const avgCost = bal && bal.quantity > 0
            ? bal.costAmount / bal.quantity
            : nom?.purchasePrice || line.price * 0.7;
          const writeOffCost = Number((avgCost * line.quantity).toFixed(2));

          // Уменьшаем локальный баланс на случай нескольких строк с одним товаром
          if (bal) {
            bal.quantity -= line.quantity;
            bal.costAmount -= writeOffCost;
          }

          stockMovements.push({
            id: makeStockId(),
            docId: doc.id,
            docPresentation: presentation,
            period,
            movementType: 'Расход',
            warehouseId: whId,
            warehouseName: whName,
            nomenclatureId: line.nomenclatureId,
            nomenclatureName: line.nomenclatureName,
            quantity: line.quantity,
            costAmount: writeOffCost,
          });

          // Проводка 1: Списание себестоимости Дт 90.02.1 — Кт 41.01
          entries.push({
            id: makeEntryId(),
            docId: doc.id,
            docType: doc.docType,
            docPresentation: presentation,
            period,
            debitAccount: '90.02.1',
            debitSubconto1: 'Основная номенклатурная группа',
            creditAccount: line.accountCode || '41.01',
            creditSubconto1: line.nomenclatureName,
            creditSubconto2: whName,
            quantityCredit: line.quantity,
            amount: writeOffCost,
            content: `Списание себестоимости: ${line.nomenclatureName}`,
          });
        }

        // Проводка 2: Выручка от реализации Дт 62.01 — Кт 90.01.1 (на полную сумму с НДС)
        entries.push({
          id: makeEntryId(),
          docId: doc.id,
          docType: doc.docType,
          docPresentation: presentation,
          period,
          debitAccount: '62.01',
          debitSubconto1: cpName,
          debitSubconto2: cp?.contract,
          creditAccount: '90.01.1',
          creditSubconto1: 'Основная номенклатурная группа',
          amount: Number(line.total.toFixed(2)),
          content: `Выручка от реализации: ${line.nomenclatureName}`,
        });

        // Проводка 3: Начислен НДС с реализации Дт 90.03 — Кт 68.02
        if (line.vatAmount > 0) {
          entries.push({
            id: makeEntryId(),
            docId: doc.id,
            docType: doc.docType,
            docPresentation: presentation,
            period,
            debitAccount: '90.03',
            debitSubconto1: 'НДС с продаж',
            creditAccount: '68.02',
            creditSubconto1: 'Налог (взносы): начислено / уплачено',
            amount: Number(line.vatAmount.toFixed(2)),
            content: `Начислен НДС с реализации (${line.vatRate})`,
          });
        }
      }
      break;
    }

    case 'ПриходныйКассовыйОрдер': {
      if (doc.amount <= 0) {
        return { ok: false, errorMessage: 'Сумма кассового ордера должна быть больше нуля!', entries: [], stockMovements: [] };
      }
      entries.push({
        id: makeEntryId(),
        docId: doc.id,
        docType: doc.docType,
        docPresentation: presentation,
        period,
        debitAccount: '50.01',
        debitSubconto1: doc.cashFlowArticle || 'Оплата от покупателей',
        creditAccount: '62.01',
        creditSubconto1: cpName,
        amount: Number(doc.amount.toFixed(2)),
        content: doc.comment || `Принята наличная оплата от ${cpName}`,
      });
      break;
    }

    case 'РасходныйКассовыйОрдер': {
      if (doc.amount <= 0) {
        return { ok: false, errorMessage: 'Сумма РКО должна быть больше нуля!', entries: [], stockMovements: [] };
      }
      const creditTarget = doc.employeeId ? '70' : '60.01';
      const targetName = doc.employeeId ? empName : cpName;
      entries.push({
        id: makeEntryId(),
        docId: doc.id,
        docType: doc.docType,
        docPresentation: presentation,
        period,
        debitAccount: creditTarget,
        debitSubconto1: targetName,
        creditAccount: '50.01',
        creditSubconto1: doc.cashFlowArticle || 'Выдача наличных из кассы',
        amount: Number(doc.amount.toFixed(2)),
        content: doc.comment || `Выдача наличных: ${targetName}`,
      });
      break;
    }

    case 'ПоступлениеНаРасчетныйСчет': {
      if (doc.amount <= 0) {
        return { ok: false, errorMessage: 'Сумма поступления на р/с должна быть больше нуля!', entries: [], stockMovements: [] };
      }
      entries.push({
        id: makeEntryId(),
        docId: doc.id,
        docType: doc.docType,
        docPresentation: presentation,
        period,
        debitAccount: '51',
        debitSubconto1: 'Основной расчетный счет',
        debitSubconto2: doc.cashFlowArticle || 'Оплата от покупателей',
        creditAccount: '62.01',
        creditSubconto1: cpName,
        amount: Number(doc.amount.toFixed(2)),
        content: doc.comment || `Безналичная оплата от покупателя ${cpName}`,
      });
      break;
    }

    case 'СписаниеСРасчетногоСчета': {
      if (doc.amount <= 0) {
        return { ok: false, errorMessage: 'Сумма списания с р/с должна быть больше нуля!', entries: [], stockMovements: [] };
      }
      entries.push({
        id: makeEntryId(),
        docId: doc.id,
        docType: doc.docType,
        docPresentation: presentation,
        period,
        debitAccount: '60.01',
        debitSubconto1: cpName,
        creditAccount: '51',
        creditSubconto1: 'Основной расчетный счет',
        creditSubconto2: doc.cashFlowArticle || 'Оплата поставщику',
        amount: Number(doc.amount.toFixed(2)),
        content: doc.comment || `Оплата поставщику ${cpName} по банку`,
      });
      break;
    }

    case 'НачислениеЗарплаты': {
      const targetEmployees = doc.employeeId
        ? state.employees.filter((e) => e.id === doc.employeeId)
        : state.employees;

      const grossSalary = doc.amount > 0
        ? doc.amount
        : targetEmployees.reduce((sum, e) => sum + e.salary, 0);

      const ndfl = Number((grossSalary * 0.13).toFixed(2));
      const insurance = Number((grossSalary * 0.30).toFixed(2));

      // Дт 26 — Кт 70 (Начислен оклад)
      entries.push({
        id: makeEntryId(),
        docId: doc.id,
        docType: doc.docType,
        docPresentation: presentation,
        period,
        debitAccount: '26',
        debitSubconto1: 'Оплата труда',
        creditAccount: '70',
        creditSubconto1: empName,
        amount: Number(grossSalary.toFixed(2)),
        content: `Начислена заработная плата (${empName})`,
      });

      // Дт 70 — Кт 68.01 (Удержан НДФЛ 13%)
      entries.push({
        id: makeEntryId(),
        docId: doc.id,
        docType: doc.docType,
        docPresentation: presentation,
        period,
        debitAccount: '70',
        debitSubconto1: empName,
        creditAccount: '68.01',
        creditSubconto1: 'НДФЛ при исполнении обязанностей налогового агента',
        amount: ndfl,
        content: 'Удержан НДФЛ 13% с зарплаты сотрудников',
      });

      // Дт 26 — Кт 69.09 (Страховые взносы 30%)
      entries.push({
        id: makeEntryId(),
        docId: doc.id,
        docType: doc.docType,
        docPresentation: presentation,
        period,
        debitAccount: '26',
        debitSubconto1: 'Страховые взносы',
        creditAccount: '69.09',
        creditSubconto1: 'Страховые взносы по единому тарифу (30%)',
        amount: insurance,
        content: 'Начислены страховые взносы по единому тарифу 30%',
      });
      break;
    }

    case 'ОперацияБух': {
      const manual = doc.manualEntries || [];
      if (manual.length === 0) {
        return { ok: false, errorMessage: 'Добавьте хотя бы одну бухгалтерскую проводку в Операцию!', entries: [], stockMovements: [] };
      }
      for (const m of manual) {
        entries.push({
          id: makeEntryId(),
          docId: doc.id,
          docType: doc.docType,
          docPresentation: presentation,
          period,
          debitAccount: m.debitAccount,
          debitSubconto1: m.debitSubconto,
          creditAccount: m.creditAccount,
          creditSubconto1: m.creditSubconto,
          amount: Number(m.amount.toFixed(2)),
          content: m.content || doc.comment,
        });
      }
      break;
    }
  }

  return { ok: true, entries, stockMovements };
}

/**
 * Перепроводит все проведенные документы в хронологическом порядке и строит регистры
 */
export function rebuildAllRegisters(state: InfobaseState): {
  accountingEntries: AccountingEntry[];
  stockMovements: StockMovement[];
} {
  const sortedDocs = [...state.documents]
    .filter((d) => d.posted && !d.markedForDeletion)
    .sort((a, b) => a.date.localeCompare(b.date));

  const allEntries: AccountingEntry[] = [];
  const allStock: StockMovement[] = [];

  for (const doc of sortedDocs) {
    const res = generateMovementsForDocument(doc, state, allStock, false);
    if (res.ok) {
      allEntries.push(...res.entries);
      allStock.push(...res.stockMovements);
    }
  }

  return {
    accountingEntries: allEntries,
    stockMovements: allStock,
  };
}

// --- БУХГАЛТЕРСКИЕ ОТЧЕТЫ (ОСВ, Карточка счета) ---

export interface OSVRow {
  accountCode: string;
  accountName: string;
  kind: ChartAccount['kind'];
  openDebit: number;
  openCredit: number;
  turnDebit: number;
  turnCredit: number;
  closeDebit: number;
  closeCredit: number;
}

export function buildOSVReport(
  chart: ChartAccount[],
  entries: AccountingEntry[],
  dateFrom?: string,
  dateTo?: string
): { rows: OSVRow[]; totals: Omit<OSVRow, 'accountCode' | 'accountName' | 'kind'> } {
  const rows: OSVRow[] = [];

  const accMap = new Map<string, ChartAccount>();
  for (const c of chart) accMap.set(c.code, c);

  // Собираем все задействованные счета
  const usedCodes = new Set<string>();
  for (const e of entries) {
    usedCodes.add(e.debitAccount);
    usedCodes.add(e.creditAccount);
  }

  const sortedCodes = Array.from(usedCodes).sort((a, b) => a.localeCompare(b));

  let totOpenDt = 0;
  let totOpenKt = 0;
  let totTurnDt = 0;
  let totTurnKt = 0;
  let totCloseDt = 0;
  let totCloseKt = 0;

  for (const code of sortedCodes) {
    const meta = accMap.get(code) || {
      code,
      name: `Счет ${code}`,
      kind: 'Активно-пассивный' as const,
    };

    let beforeDt = 0;
    let beforeKt = 0;
    let periodDt = 0;
    let periodKt = 0;

    for (const e of entries) {
      const isBefore = dateFrom && e.period < dateFrom;
      const isAfter = dateTo && e.period > dateTo;
      if (isAfter) continue;

      if (e.debitAccount === code) {
        if (isBefore) beforeDt += e.amount;
        else periodDt += e.amount;
      }
      if (e.creditAccount === code) {
        if (isBefore) beforeKt += e.amount;
        else periodKt += e.amount;
      }
    }

    const calcNet = (dt: number, kt: number): [number, number] => {
      const net = Number((dt - kt).toFixed(2));
      // Показываем сальдо по стороне знака; это свёрнутый остаток без аналитики.
      return net >= 0 ? [net, 0] : [0, Math.abs(net)];
    };

    const [openDebit, openCredit] = calcNet(beforeDt, beforeKt);
    const [closeDebit, closeCredit] = calcNet(openDebit + periodDt, openCredit + periodKt);

    if (openDebit === 0 && openCredit === 0 && periodDt === 0 && periodKt === 0) continue;

    rows.push({
      accountCode: code,
      accountName: meta.name,
      kind: meta.kind,
      openDebit: Number(openDebit.toFixed(2)),
      openCredit: Number(openCredit.toFixed(2)),
      turnDebit: Number(periodDt.toFixed(2)),
      turnCredit: Number(periodKt.toFixed(2)),
      closeDebit: Number(closeDebit.toFixed(2)),
      closeCredit: Number(closeCredit.toFixed(2)),
    });

    totOpenDt += openDebit;
    totOpenKt += openCredit;
    totTurnDt += periodDt;
    totTurnKt += periodKt;
    totCloseDt += closeDebit;
    totCloseKt += closeCredit;
  }

  return {
    rows,
    totals: {
      openDebit: Number(totOpenDt.toFixed(2)),
      openCredit: Number(totOpenKt.toFixed(2)),
      turnDebit: Number(totTurnDt.toFixed(2)),
      turnCredit: Number(totTurnKt.toFixed(2)),
      closeDebit: Number(totCloseDt.toFixed(2)),
      closeCredit: Number(totCloseKt.toFixed(2)),
    },
  };
}

/** Replay chronologically and reject the entire change if a later document would become invalid. */
export function rebuildRegistersChecked(state: InfobaseState): {ok: true; accountingEntries: AccountingEntry[]; stockMovements: StockMovement[]} | {ok: false; errorMessage: string} {
  const accountingEntries: AccountingEntry[] = [];
  const stockMovements: StockMovement[] = [];
  const docs = state.documents.filter(d => d.posted && !d.markedForDeletion).slice().sort((a,b)=>a.date.localeCompare(b.date));
  for (const doc of docs) {
    const result = generateMovementsForDocument(doc, state, stockMovements, true);
    if (!result.ok) return {ok:false,errorMessage:result.errorMessage || `Не удалось провести ${getDocPresentation(doc)}`};
    accountingEntries.push(...result.entries);
    stockMovements.push(...result.stockMovements);
  }
  return {ok:true,accountingEntries,stockMovements};
}
