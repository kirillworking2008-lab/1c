import { InfobaseState } from '../types/oneC';
import { calculateWarehouseBalances, getDocPresentation } from './accountingEngine';

export interface QueryResultTable {
  columns: string[];
  rows: Record<string, any>[];
  executionTimeMs: number;
  translatedInfo: string;
  error?: string;
}

/**
 * Учебный интерпретатор ограниченного подмножества языка запросов.
 * Поддерживает: ВЫБРАТЬ, ПЕРВЫЕ N, РАЗЛИЧНЫЕ, КАК, ИЗ, ГДЕ, СГРУППИРОВАТЬ ПО,
 * СУММА(), КОЛИЧЕСТВО(), МАКСИМУМ(), МИНИМУМ(), СРЕДНЕЕ(), УПОРЯДОЧИТЬ ПО (ВОЗР/УБЫВ),
 * параметры &Параметр, виртуальную таблицу РегистрНакопления.ТоварыНаСкладах.Остатки
 */
export function execute1CQuery(
  rawQuery: string,
  state: InfobaseState,
  params: Record<string, any> = {}
): QueryResultTable {
  const start = performance.now();

  try {
    // 1. Очищаем комментарии // и переносы строки с вертикальной чертой | (формат многострочной строки 1С)
    const cleanedLines = rawQuery
      .split('\n')
      .map((line) => {
        const noComment = line.replace(/\/\/.*$/, '');
        return noComment.replace(/^\s*\|/, ' ');
      });

    let q = cleanedLines.join(' ').replace(/\s+/g, ' ').trim();
    // Убираем обрамляющие кавычки если пользователь вставил текст прямо из модуля
    if (q.startsWith('"') && q.endsWith('"')) {
      q = q.slice(1, -1).trim();
    }
    if (q.endsWith(';')) {
      q = q.slice(0, -1).trim();
    }

    if (!q) {
      return {
        columns: [],
        rows: [],
        executionTimeMs: 0,
        translatedInfo: '',
        error: 'Текст запроса пуст. Введите выражение ВЫБРАТЬ ... ИЗ ...',
      };
    }

    // Подстановка параметров &ИмяПараметра
    for (const [k, v] of Object.entries(params)) {
      if (!/^[А-Яа-яЁёA-Za-z_][А-Яа-яЁёA-Za-z0-9_]*$/.test(k)) throw new Error('Недопустимое имя параметра');
      const regex = new RegExp(`&${k}(?![А-Яа-яЁёA-Za-z0-9_])`, 'gi');
      if (typeof v === 'string' && v.includes('"')) throw new Error('Кавычки в параметрах пока не поддерживаются');
      const replacement = typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'ИСТИНА' : 'ЛОЖЬ') : `"${String(v)}"`;
      q = q.replace(regex, replacement);
    }

    // Разбор структуры запроса:
    // ВЫБРАТЬ [РАЗЛИЧНЫЕ] [ПЕРВЫЕ N] <Поля> ИЗ <Источник> [КАК <Псевдоним>] [ГДЕ <Условие>] [СГРУППИРОВАТЬ ПО <Поля>] [УПОРЯДОЧИТЬ ПО <Поля>]
    const selectMatch = q.match(/^(?:ВЫБРАТЬ|SELECT)\s+([\s\S]+?)\s+(?:ИЗ|FROM)\s+([\s\S]+)$/i);
    if (!selectMatch) {
      return {
        columns: [],
        rows: [],
        executionTimeMs: Math.round((performance.now() - start) * 100) / 100,
        translatedInfo: '',
        error: 'Синтаксическая ошибка: ожидается ключевое слово ВЫБРАТЬ ... ИЗ ...',
      };
    }

    let selectPart = selectMatch[1].trim();
    const restPart = selectMatch[2].trim();

    let isDistinct = false;
    if (/^(?:РАЗЛИЧНЫЕ|DISTINCT)\s+/i.test(selectPart)) {
      isDistinct = true;
      selectPart = selectPart.replace(/^(?:РАЗЛИЧНЫЕ|DISTINCT)\s+/i, '').trim();
    }

    let topLimit: number | null = null;
    const topMatch = selectPart.match(/^(?:ПЕРВЫЕ|TOP)\s+(\d+)\s+([\s\S]+)$/i);
    if (topMatch) {
      topLimit = parseInt(topMatch[1], 10);
      selectPart = topMatch[2].trim();
    }

    // Разбиваем restPart по ключевым секциям ГДЕ, СГРУППИРОВАТЬ ПО, УПОРЯДОЧИТЬ ПО
    let fromClause = restPart;
    let whereClause = '';
    let groupClause = '';
    let orderClause = '';

    // УПОРЯДОЧИТЬ ПО
    const orderSplit = splitByKeyword(fromClause, /(?:УПОРЯДОЧИТЬ\s+ПО|ORDER\s+BY)/i);
    if (orderSplit) {
      fromClause = orderSplit[0].trim();
      orderClause = orderSplit[1].trim();
    }

    // СГРУППИРОВАТЬ ПО
    const groupSplit = splitByKeyword(fromClause, /(?:СГРУППИРОВАТЬ\s+ПО|GROUP\s+BY)/i);
    if (groupSplit) {
      fromClause = groupSplit[0].trim();
      groupClause = groupSplit[1].trim();
    }

    // ГДЕ
    const whereSplit = splitByKeyword(fromClause, /(?:ГДЕ|WHERE)/i);
    if (whereSplit) {
      fromClause = whereSplit[0].trim();
      whereClause = whereSplit[1].trim();
    }

    // Разбираем источник данных в секции ИЗ
    const { sourceName, tableAlias, dataset } = resolveDataSource(fromClause, state);

    // Фильтрация ГДЕ
    let filteredRows = dataset;
    if (whereClause) {
      filteredRows = dataset.filter((row) => evaluateWhereCondition(whereClause, row, tableAlias));
    }

    // Парсим список выбираемых полей
    const selectFields = splitCommaOutsideParens(selectPart).map((rawField) =>
      parseSelectField(rawField.trim(), tableAlias)
    );

    const hasAggregates = selectFields.some((f) => f.aggregate !== null) || Boolean(groupClause);

    let resultRows: Record<string, any>[] = [];
    let columns: string[] = [];

    if (selectFields.length === 1 && selectFields[0].expr === '*') {
      columns = filteredRows.length > 0 ? Object.keys(filteredRows[0]) : ['Данные'];
      resultRows = filteredRows.map((r) => ({ ...r }));
    } else if (hasAggregates) {
      const groupFields = groupClause
        ? splitCommaOutsideParens(groupClause).map((g) => stripTableAlias(g.trim(), tableAlias))
        : [];

      const groups = new Map<string, Record<string, any>[]>();
      for (const row of filteredRows) {
        const keyParts = groupFields.map((gf) => String(getFieldValue(row, gf) ?? ''));
        const key = keyParts.join('||');
        const arr = groups.get(key) || [];
        arr.push(row);
        groups.set(key, arr);
      }

      if (groups.size === 0 && groupFields.length === 0) {
        groups.set('__all__', []);
      }

      columns = selectFields.map((f) => f.alias);
      for (const [, groupRows] of groups.entries()) {
        const outRow: Record<string, any> = {};
        for (const sf of selectFields) {
          if (sf.aggregate) {
            outRow[sf.alias] = computeAggregate(sf.aggregate, sf.innerField, groupRows);
          } else {
            outRow[sf.alias] = groupRows.length > 0 ? evaluateExpression(sf.expr, groupRows[0]) : null;
          }
        }
        resultRows.push(outRow);
      }
    } else {
      columns = selectFields.map((f) => f.alias);
      resultRows = filteredRows.map((row) => {
        const outRow: Record<string, any> = {};
        for (const sf of selectFields) {
          outRow[sf.alias] = evaluateExpression(sf.expr, row);
        }
        return outRow;
      });
    }

    // РАЗЛИЧНЫЕ
    if (isDistinct) {
      const seen = new Set<string>();
      resultRows = resultRows.filter((r) => {
        const k = JSON.stringify(r);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }

    // УПОРЯДОЧИТЬ ПО
    if (orderClause) {
      const orderSpecs = splitCommaOutsideParens(orderClause).map((part) => {
        const m = part.trim().match(/^([\s\S]+?)(?:\s+(ВОЗР|УБЫВ|ASC|DESC))?$/i);
        const fieldName = stripTableAlias((m ? m[1] : part).trim(), tableAlias);
        const dir = m && m[2] && /^(?:УБЫВ|DESC)$/i.test(m[2]) ? -1 : 1;
        return { fieldName, dir };
      });

      resultRows.sort((a, b) => {
        for (const spec of orderSpecs) {
          const va = getFieldValue(a, spec.fieldName);
          const vb = getFieldValue(b, spec.fieldName);
          if (va === vb) continue;
          if (typeof va === 'number' && typeof vb === 'number') {
            return (va - vb) * spec.dir;
          }
          return String(va ?? '').localeCompare(String(vb ?? ''), 'ru') * spec.dir;
        }
        return 0;
      });
    }

    // ПЕРВЫЕ N
    if (topLimit !== null && topLimit >= 0) {
      resultRows = resultRows.slice(0, topLimit);
    }

    const elapsed = Math.round((performance.now() - start) * 100) / 100;
    return {
      columns,
      rows: resultRows,
      executionTimeMs: elapsed,
      translatedInfo: `Источник: ${sourceName} | Отобрано строк: ${resultRows.length}`,
    };
  } catch (err: any) {
    return {
      columns: [],
      rows: [],
      executionTimeMs: Math.round((performance.now() - start) * 100) / 100,
      translatedInfo: '',
      error: err?.message || 'Ошибка выполнения запроса 1С',
    };
  }
}

function splitByKeyword(input: string, keywordRegex: RegExp): [string, string] | null {
  let quoted = false, depth = 0;
  for (let i=0; i<input.length; i++) {
    const c=input[i];
    if (c==='"') { if (quoted && input[i+1]==='"') {i++;continue;} quoted=!quoted;continue; }
    if (quoted) continue;
    if (c==='(') {depth++;continue;} if(c===')'){depth--;continue;}
    if(depth!==0) continue;
    const match=input.slice(i).match(new RegExp('^(?:'+keywordRegex.source+')', 'i'));
    const isIdent=(v:string|undefined)=>!!v && /[А-Яа-яЁёA-Za-z0-9_]/.test(v);
    if(match && !isIdent(input[i-1]) && !isIdent(input[i+match[0].length])) return [input.slice(0,i),input.slice(i+match[0].length)];
  }
  return null;
}

function splitCommaOutsideParens(str: string): string[] {
  const res: string[] = [];
  let depth = 0;
  let inQuotes = false;
  let current = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"') inQuotes = !inQuotes;
    if (!inQuotes) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      else if (ch === ',' && depth === 0) {
        res.push(current);
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) res.push(current);
  return res;
}

function stripTableAlias(expr: string, tableAlias: string): string {
  if (!tableAlias) return expr;
  const prefix = `${tableAlias}.`;
  if (expr.toLowerCase().startsWith(prefix.toLowerCase())) {
    return expr.slice(prefix.length);
  }
  return expr;
}

interface ParsedSelectField {
  expr: string;
  alias: string;
  aggregate: 'СУММА' | 'КОЛИЧЕСТВО' | 'МАКСИМУМ' | 'МИНИМУМ' | 'СРЕДНЕЕ' | null;
  innerField: string;
}

function parseSelectField(raw: string, tableAlias: string): ParsedSelectField {
  let exprPart = raw;
  let explicitAlias = '';

  const aliasMatch = raw.match(/^([\s\S]+?)\s+(?:КАК|AS)\s+([А-Яа-яЁёA-Za-z0-9_]+)$/i);
  if (aliasMatch) {
    exprPart = aliasMatch[1].trim();
    explicitAlias = aliasMatch[2].trim();
  }

  const aggMatch = exprPart.match(/^(СУММА|КОЛИЧЕСТВО|МАКСИМУМ|МИНИМУМ|СРЕДНЕЕ|SUM|COUNT|MAX|MIN|AVG)\s*\(([\s\S]*)\)$/i);
  if (aggMatch) {
    const rawAgg = aggMatch[1].toUpperCase();
    const mapAgg: Record<string, ParsedSelectField['aggregate']> = {
      СУММА: 'СУММА',
      SUM: 'СУММА',
      КОЛИЧЕСТВО: 'КОЛИЧЕСТВО',
      COUNT: 'КОЛИЧЕСТВО',
      МАКСИМУМ: 'МАКСИМУМ',
      MAX: 'МАКСИМУМ',
      МИНИМУМ: 'МИНИМУМ',
      MIN: 'МИНИМУМ',
      СРЕДНЕЕ: 'СРЕДНЕЕ',
      AVG: 'СРЕДНЕЕ',
    };
    const inner = stripTableAlias(aggMatch[2].replace(/^РАЗЛИЧНЫЕ\s+/i, '').trim(), tableAlias);
    const defaultAlias = explicitAlias || `${ inner && inner !== '*' ? inner : 'Количество' }`;
    return {
      expr: exprPart,
      alias: defaultAlias,
      aggregate: mapAgg[rawAgg] || 'СУММА',
      innerField: inner,
    };
  }

  const cleanedExpr = stripTableAlias(exprPart, tableAlias);
  const autoAlias = explicitAlias || cleanedExpr.replace(/[^А-Яа-яЁёA-Za-z0-9_]/g, '') || 'Поле';
  return {
    expr: cleanedExpr,
    alias: autoAlias,
    aggregate: null,
    innerField: '',
  };
}

function computeAggregate(
  agg: NonNullable<ParsedSelectField['aggregate']>,
  field: string,
  rows: Record<string, any>[]
): number {
  if (agg === 'КОЛИЧЕСТВО') {
    if (!field || field === '*') return rows.length;
    return rows.filter((r) => getFieldValue(r, field) !== null && getFieldValue(r, field) !== undefined).length;
  }
  const nums = rows.map((r) => Number(getFieldValue(r, field) || 0));
  if (nums.length === 0) return 0;
  if (agg === 'СУММА') return Number(nums.reduce((a, b) => a + b, 0).toFixed(2));
  if (agg === 'МАКСИМУМ') return Math.max(...nums);
  if (agg === 'МИНИМУМ') return Math.min(...nums);
  if (agg === 'СРЕДНЕЕ') return Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2));
  return 0;
}

function resolveDataSource(
  fromClause: string,
  state: InfobaseState
): { sourceName: string; tableAlias: string; dataset: Record<string, any>[] } {
  // Убираем возможные параметры виртуальной таблицы в скобках, например Остатки(&Дата) КАК Остатки
  let cleaned = fromClause.trim();
  let tableAlias = '';

  const aliasMatch = cleaned.match(/^([\s\S]+?)\s+(?:КАК|AS)\s+([А-Яа-яЁёA-Za-z0-9_]+)$/i);
  if (aliasMatch) {
    cleaned = aliasMatch[1].trim();
    tableAlias = aliasMatch[2].trim();
  } else {
    const simpleAlias = cleaned.match(/^([А-Яа-яЁёA-Za-z0-9_.]+(?:\([^)]*\))?)\s+([А-Яа-яЁёA-Za-z0-9_]+)$/);
    if (simpleAlias) {
      cleaned = simpleAlias[1].trim();
      tableAlias = simpleAlias[2].trim();
    }
  }

  // Игнорировать параметры виртуальной таблицы было бы опасно: выдаём явную ошибку.
  if (/\(\s*[^)\s]+/.test(cleaned)) throw new Error('Параметры виртуальных таблиц пока не поддерживаются');
  const baseTable = cleaned.replace(/\([^)]*\)/g, '').trim();
  const lower = baseTable.toLowerCase();

  if (!tableAlias) {
    const parts = baseTable.split('.');
    tableAlias = parts[parts.length - 1];
  }

  // 1. Справочник.Номенклатура
  if (lower === 'справочник.номенклатура' || lower === 'catalog.nomenclature') {
    return {
      sourceName: 'Справочник.Номенклатура',
      tableAlias,
      dataset: state.nomenclature.map((n) => ({
        Ссылка: n.name,
        Код: n.code,
        Артикул: n.article,
        Наименование: n.name,
        ВидНоменклатуры: n.type,
        ЕдиницаИзмерения: n.unit,
        СтавкаНДС: n.vatRate,
        ЦенаЗакупки: n.purchasePrice,
        ЦенаПродажи: n.salePrice,
        СчетУчета: n.accountCode,
      })),
    };
  }

  // 2. Справочник.Контрагенты
  if (lower === 'справочник.контрагенты' || lower === 'catalog.counterparties') {
    return {
      sourceName: 'Справочник.Контрагенты',
      tableAlias,
      dataset: state.counterparties.map((c) => ({
        Ссылка: c.name,
        Код: c.code,
        Наименование: c.name,
        ИНН: c.inn,
        КПП: c.kpp,
        ВидКонтрагента: c.type,
        Роль: c.role,
        Телефон: c.phone,
        ОсновнойДоговор: c.contract,
      })),
    };
  }

  // 3. Справочник.Сотрудники
  if (lower === 'справочник.сотрудники' || lower === 'catalog.employees') {
    return {
      sourceName: 'Справочник.Сотрудники',
      tableAlias,
      dataset: state.employees.map((e) => ({
        Ссылка: e.fullName,
        Код: e.code,
        Наименование: e.fullName,
        ФИО: e.fullName,
        Должность: e.position,
        Подразделение: e.department,
        Оклад: e.salary,
        ИНН: e.inn,
        ДатаПриема: e.hireDate,
      })),
    };
  }

  // 4. Справочник.Склады
  if (lower === 'справочник.склады') {
    return {
      sourceName: 'Справочник.Склады',
      tableAlias,
      dataset: state.warehouses.map((w) => ({
        Ссылка: w.name,
        Код: w.code,
        Наименование: w.name,
        ТипСклада: w.type,
        Ответственный: w.responsible,
      })),
    };
  }

  // 5. Справочник.Организации
  if (lower === 'справочник.организации') {
    return {
      sourceName: 'Справочник.Организации',
      tableAlias,
      dataset: state.organizations.map((o) => ({
        Ссылка: o.name,
        Код: o.code,
        Наименование: o.name,
        ПолноеНаименование: o.fullName,
        ИНН: o.inn,
        КПП: o.kpp,
        СистемаНалогообложения: o.taxSystem,
      })),
    };
  }

  // 6. ПланСчетов.Хозрасчетный
  if (lower === 'плансчетов.хозрасчетный') {
    return {
      sourceName: 'ПланСчетов.Хозрасчетный',
      tableAlias,
      dataset: state.chartOfAccounts.map((a) => ({
        Код: a.code,
        Наименование: a.name,
        Вид: a.kind,
        Субконто1: a.subconto1 || '',
        Количественный: a.isQuantitative ? 'Истина' : 'Ложь',
      })),
    };
  }

  // 7. Документы (ПоступлениеТоваровУслуг, РеализацияТоваровУслуг и др. или общий ЖурналДокументов)
  if (lower.startsWith('документ.')) {
    const docTypePart = baseTable.split('.')[1];
    const validDocTypes = ['ПоступлениеТоваровУслуг','РеализацияТоваровУслуг','ПриходныйКассовыйОрдер','РасходныйКассовыйОрдер','ПоступлениеНаРасчетныйСчет','СписаниеСРасчетногоСчета','НачислениеЗарплаты','ОперацияБух'];
    if (!validDocTypes.some(t=>t.toLowerCase()===docTypePart?.toLowerCase()) || (baseTable.split('.')[2] && baseTable.split('.')[2].toLowerCase()!=='товары') || baseTable.split('.').length>3) throw new Error(`Неизвестная таблица ${baseTable}`);
    const cpMap = new Map(state.counterparties.map((c) => [c.id, c.name]));
    const whMap = new Map(state.warehouses.map((w) => [w.id, w.name]));
    const orgMap = new Map(state.organizations.map((o) => [o.id, o.name]));

    // Проверим табличную часть Документ.РеализацияТоваровУслуг.Товары
    const subTablePart = baseTable.split('.')[2];
    const matchingDocs = state.documents.filter(
      (d) => d.docType.toLowerCase() === docTypePart.toLowerCase()
    );

    if (subTablePart && subTablePart.toLowerCase() === 'товары') {
      const rows: Record<string, any>[] = [];
      for (const d of matchingDocs) {
        d.lines.forEach((ln, i) => {
          rows.push({
            Ссылка: getDocPresentation(d),
            НомерСтроки: i + 1,
            Проведен: d.posted,
            Дата: d.date.slice(0, 10),
            Контрагент: cpMap.get(d.counterpartyId || '') || '',
            Номенклатура: ln.nomenclatureName,
            Количество: ln.quantity,
            Цена: ln.price,
            Сумма: ln.amount,
            СтавкаНДС: ln.vatRate,
            СуммаНДС: ln.vatAmount,
            Всего: ln.total,
          });
        });
      }
      return { sourceName: baseTable, tableAlias, dataset: rows };
    }

    return {
      sourceName: `Документ.${docTypePart}`,
      tableAlias,
      dataset: matchingDocs.map((d) => ({
        Ссылка: getDocPresentation(d),
        Номер: d.number,
        Дата: d.date.slice(0, 10),
        Проведен: d.posted,
        ПометкаУдаления: d.markedForDeletion,
        Организация: orgMap.get(d.organizationId) || '',
        Контрагент: cpMap.get(d.counterpartyId || '') || '',
        Склад: whMap.get(d.warehouseId || '') || '',
        СуммаДокумента: d.amount,
        СуммаНДС: d.vatAmount,
        Комментарий: d.comment,
      })),
    };
  }

  // 8. РегистрНакопления.ТоварыНаСкладах.Остатки или движения
  if (lower.startsWith('регистрнакопления.товарынаскладах')) {
    if (lower.includes('.остатки')) {
      const balMap = calculateWarehouseBalances(state.stockMovements);
      const rows: Record<string, any>[] = [];
      for (const [, val] of balMap.entries()) {
        if (val.quantity !== 0 || val.costAmount !== 0) {
          rows.push({
            Склад: val.warehouseName,
            Номенклатура: val.nomenclatureName,
            КоличествоОстаток: val.quantity,
            СуммаОстаток: Number(val.costAmount.toFixed(2)),
          });
        }
      }
      return {
        sourceName: 'РегистрНакопления.ТоварыНаСкладах.Остатки',
        tableAlias,
        dataset: rows,
      };
    }

    return {
      sourceName: 'РегистрНакопления.ТоварыНаСкладах',
      tableAlias,
      dataset: state.stockMovements.map((m) => ({
        Период: m.period,
        Регистратор: m.docPresentation,
        ВидДвижения: m.movementType,
        Склад: m.warehouseName,
        Номенклатура: m.nomenclatureName,
        Количество: m.quantity,
        Сумма: m.costAmount,
      })),
    };
  }

  // 9. РегистрБухгалтерии.Хозрасчетный (Проводки Дт/Кт)
  if (lower.startsWith('регистрбухгалтерии.хозрасчетный')) {
    return {
      sourceName: 'РегистрБухгалтерии.Хозрасчетный',
      tableAlias,
      dataset: state.accountingEntries.map((e) => ({
        Период: e.period,
        Регистратор: e.docPresentation,
        СчетДт: e.debitAccount,
        СубконтоДт1: e.debitSubconto1,
        СчетКт: e.creditAccount,
        СубконтоКт1: e.creditSubconto1,
        Сумма: e.amount,
        Содержание: e.content,
      })),
    };
  }

  // Пользовательские справочники из Конфигуратора
  const customCat = state.customCatalogs.find(
    (c) => `справочник.${c.name.toLowerCase()}` === lower
  );
  if (customCat) {
    return {
      sourceName: `Справочник.${customCat.name}`,
      tableAlias,
      dataset: [],
    };
  }

  throw new Error(
    `Таблица "${baseTable}" не найдена в метаданных конфигурации! Доступные таблицы: Справочник.Номенклатура, Справочник.Контрагенты, Справочник.Сотрудники, Справочник.Склады, ПланСчетов.Хозрасчетный, Документ.ПоступлениеТоваровУслуг, Документ.РеализацияТоваровУслуг, РегистрНакопления.ТоварыНаСкладах.Остатки, РегистрБухгалтерии.Хозрасчетный.`
  );
}

function getFieldValue(row: Record<string, any>, fieldName: string): any {
  if (fieldName in row) return row[fieldName];
  const lower = fieldName.toLowerCase();
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === lower) return row[k];
  }
  return undefined;
}

function evaluateExpression(expr: string, row: Record<string, any>): any {
  const trimmed = expr.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  // Простая арифметика вида ЦенаПродажи * 0.2 или Количество * Цена
  const mathMatch = trimmed.match(/^([А-Яа-яЁёA-Za-z0-9_]+)\s*([*+\-/])\s*([А-Яа-яЁёA-Za-z0-9_.]+)$/);
  if (mathMatch) {
    const leftRaw = mathMatch[1];
    const op = mathMatch[2];
    const rightRaw = mathMatch[3];
    const lv = /^-?\d+(\.\d+)?$/.test(leftRaw) ? Number(leftRaw) : Number(getFieldValue(row, leftRaw) || 0);
    const rv = /^-?\d+(\.\d+)?$/.test(rightRaw) ? Number(rightRaw) : Number(getFieldValue(row, rightRaw) || 0);
    if (op === '*') return Number((lv * rv).toFixed(2));
    if (op === '+') return Number((lv + rv).toFixed(2));
    if (op === '-') return Number((lv - rv).toFixed(2));
    if (op === '/') return rv !== 0 ? Number((lv / rv).toFixed(2)) : 0;
  }

  const value = getFieldValue(row, trimmed);
  if (value === undefined) throw new Error(`Поле не найдено или выражение не поддерживается: ${trimmed}`);
  return value;
}

function evaluateWhereCondition(cond: string, row: Record<string, any>, tableAlias: string): boolean {
  // Делим логические операции только вне строк и скобок.
  const trimmed=cond.trim();
  const orSplit=splitByKeyword(trimmed, /(?:ИЛИ|OR)/i);
  if(orSplit) {const a=evaluateWhereCondition(orSplit[0],row,tableAlias);const b=evaluateWhereCondition(orSplit[1],row,tableAlias);return a||b;}
  const andSplit=splitByKeyword(trimmed, /(?:И|AND)/i);
  if(andSplit) {const a=evaluateWhereCondition(andSplit[0],row,tableAlias);const b=evaluateWhereCondition(andSplit[1],row,tableAlias);return a&&b;}
  if(trimmed.startsWith('(') && trimmed.endsWith(')')) return evaluateWhereCondition(trimmed.slice(1,-1),row,tableAlias);

  let expr = cond.trim();
  let negate = false;
  if (/^(?:НЕ|NOT)\s+/i.test(expr)) {
    negate = true;
    expr = expr.replace(/^(?:НЕ|NOT)\s+/i, '').trim();
  }

  // ПОДОБНО / LIKE
  const likeMatch = expr.match(/^([А-Яа-яЁёA-Za-z0-9_.]+)\s+(?:ПОДОБНО|LIKE)\s+"([^"]*)"$/i);
  if (likeMatch) {
    const field = stripTableAlias(likeMatch[1], tableAlias);
    const pattern = likeMatch[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
    const val = String(getFieldValue(row, field) ?? '');
    const res = new RegExp(`^${pattern}$`, 'i').test(val);
    return negate ? !res : res;
  }

  const cmpMatch = expr.match(/^([А-Яа-яЁёA-Za-z0-9_.]+)\s*(>=|<=|<>|!=|=|>|<)\s*([\s\S]+)$/);
  if (!cmpMatch) throw new Error(`Неподдерживаемое условие ГДЕ: ${cond}`);

  const field = stripTableAlias(cmpMatch[1].trim(), tableAlias);
  const op = cmpMatch[2];
  const rawRhs = cmpMatch[3].trim();

  const lhs = getFieldValue(row, field);
  if (lhs === undefined) throw new Error(`Поле не найдено: ${field}`);
  let rhs: any = rawRhs;

  if (rawRhs.startsWith('"') && rawRhs.endsWith('"')) {
    rhs = rawRhs.slice(1, -1);
  } else if (/^(?:ИСТИНА|TRUE)$/i.test(rawRhs)) {
    rhs = true;
  } else if (/^(?:ЛОЖЬ|FALSE)$/i.test(rawRhs)) {
    rhs = false;
  } else if (/^-?\d+(\.\d+)?$/.test(rawRhs)) {
    rhs = Number(rawRhs);
  } else {
    rhs = getFieldValue(row, stripTableAlias(rawRhs, tableAlias));
    if (rhs === undefined) throw new Error(`Неизвестное значение: ${rawRhs}`);
  }

  let ok = false;
  if (op === '=') ok = String(lhs) === String(rhs) || lhs === rhs;
  else if (op === '<>' || op === '!=') ok = lhs !== rhs;
  else if (op === '>') ok = lhs > rhs;
  else if (op === '<') ok = lhs < rhs;
  else if (op === '>=') ok = lhs >= rhs;
  else if (op === '<=') ok = lhs <= rhs;

  return negate ? !ok : ok;
}
