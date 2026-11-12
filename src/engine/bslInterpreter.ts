import { InfobaseState } from '../types/oneC';
import { execute1CQuery } from './queryEngine1C';

export interface BSLExecutionResult {
  success: boolean;
  output: string[];
  error?: string;
  variablesSnapshot: Record<string, string>;
  durationMs: number;
}

interface Token {
  type: 'ident' | 'number' | 'string' | 'op' | 'punct' | 'eof';
  value: string;
  line: number;
}

class ReturnSignal {
  constructor(public value: any) {}
}
class BreakSignal {}
class ContinueSignal {}

/**
 * Реальный интерпретатор встроенного языка 1С:Предприятие 8.3 (BSL)
 * Поддерживает русский и английский синтаксис:
 * Перем, Процедура..КонецПроцедуры, Функция..КонецФункции, Если..Тогда..ИначеЕсли..Иначе..КонецЕсли,
 * Для..По..Цикл..КонецЦикла, Для Каждого..Из..Цикл, Пока..Цикл, Возврат, Прервать, Продолжить,
 * Новый Запрос, Новый Массив, Новый Структура, Новый Соответствие, Новый ТаблицаЗначений,
 * Справочники.*, Документы.*, Сообщить(), Окр(), СтрДлина(), ВРег(), НРег(), СокрЛП(), СтрЗаменить(), ТекущаяДата() и др.
 */
export function executeBSLCode(code: string, state: InfobaseState): BSLExecutionResult {
  const start = performance.now();
  const output: string[] = [];

  try {
    const tokens = tokenizeBSL(code);
    const parser = new BSLInterpreter(tokens, state, (msg) => {
      output.push(format1CValue(msg));
    });

    parser.runProgram();

    const snap: Record<string, string> = {};
    for (const [k, v] of parser.globalScope.entries()) {
      snap[k] = summarizeDebugValue(v);
    }

    return {
      success: true,
      output,
      variablesSnapshot: snap,
      durationMs: Math.round((performance.now() - start) * 100) / 100,
    };
  } catch (err: any) {
    return {
      success: false,
      output,
      error: err?.message || String(err),
      variablesSnapshot: {},
      durationMs: Math.round((performance.now() - start) * 100) / 100,
    };
  }
}

export function checkBSLSyntax(code: string): { valid: boolean; errors: string[] } {
  try {
    const tokens = tokenizeBSL(code);
    const errors: string[] = [];
    // Проверяем парность блоков Если/КонецЕсли, Цикл/КонецЦикла, Процедура/КонецПроцедуры, Функция/КонецФункции
    const stack: { kw: string; line: number }[] = [];
    for (const t of tokens) {
      if (t.type !== 'ident') continue;
      const u = t.value.toLowerCase();
      if (u === 'процедура' || u === 'procedure') stack.push({ kw: 'Процедура', line: t.line });
      else if (u === 'функция' || u === 'function') stack.push({ kw: 'Функция', line: t.line });
      else if (u === 'если' || u === 'if') stack.push({ kw: 'Если', line: t.line });
      else if (u === 'цикл' || u === 'do') stack.push({ kw: 'Цикл', line: t.line });
      else if (u === 'конецпроцедуры' || u === 'endprocedure') {
        const top = stack.pop();
        if (!top || top.kw !== 'Процедура') errors.push(`Строка ${t.line}: Неожиданное "КонецПроцедуры"`);
      } else if (u === 'конецфункции' || u === 'endfunction') {
        const top = stack.pop();
        if (!top || top.kw !== 'Функция') errors.push(`Строка ${t.line}: Неожиданное "КонецФункции"`);
      } else if (u === 'конецесли' || u === 'endif') {
        const top = stack.pop();
        if (!top || top.kw !== 'Если') errors.push(`Строка ${t.line}: Неожиданное "КонецЕсли"`);
      } else if (u === 'конеццикла' || u === 'enddo') {
        const top = stack.pop();
        if (!top || top.kw !== 'Цикл') errors.push(`Строка ${t.line}: Неожиданное "КонецЦикла"`);
      }
    }
    for (const unclosed of stack) {
      errors.push(`Строка ${unclosed.line}: Не закрыт блок "${unclosed.kw}"`);
    }
    return { valid: errors.length === 0, errors };
  } catch (e: any) {
    return { valid: false, errors: [e?.message || 'Синтаксическая ошибка'] };
  }
}

function tokenizeBSL(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;

  while (i < src.length) {
    const ch = src[i];

    if (ch === '\n') {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Директивы препроцессора #Область, #КонецОбласти, &НаСервере, &НаКлиенте
    if (ch === '#' || ch === '&') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    // Однострочный комментарий //
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    // Многострочная строка 1С "..." с поддержкой продолжения строки через |
    if (ch === '"') {
      const startLine = line;
      let str = '';
      i++; // skip opening "
      while (i < src.length) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') {
            str += '"';
            i += 2;
            continue;
          }
          // Проверим продолжение многострочной строки 1С после закрытия? В 1С перенос делается ДО закрывающей кавычки с символом | в начале новой строки
          i++;
          break;
        }
        if (src[i] === '\n') {
          line++;
          str += '\n';
          i++;
          // Пропускаем пробелы и символ | в начале следующей строки многострочного литерала 1С
          while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\r')) i++;
          if (src[i] === '|') i++;
          continue;
        }
        str += src[i];
        i++;
      }
      tokens.push({ type: 'string', value: str, line: startLine });
      continue;
    }

    // Литерал даты '20260115'
    if (ch === "'") {
      let dt = '';
      i++;
      while (i < src.length && src[i] !== "'") {
        if (src[i] === '\n') line++;
        dt += src[i++];
      }
      i++;
      tokens.push({ type: 'string', value: dt, line });
      continue;
    }

    // Число
    if (/\d/.test(ch)) {
      let num = '';
      while (i < src.length && /[\d.]/.test(src[i])) {
        num += src[i++];
      }
      tokens.push({ type: 'number', value: num, line });
      continue;
    }

    // Идентификатор или ключевое слово (рус/англ)
    if (/[А-Яа-яЁёA-Za-z_]/.test(ch)) {
      let id = '';
      while (i < src.length && /[А-Яа-яЁёA-Za-z0-9_]/.test(src[i])) {
        id += src[i++];
      }
      tokens.push({ type: 'ident', value: id, line });
      continue;
    }

    // Двухсимвольные операторы
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '<>' || two === '!=') {
      tokens.push({ type: 'op', value: two, line });
      i += 2;
      continue;
    }

    if ('+-*/%=<>'.includes(ch)) {
      tokens.push({ type: 'op', value: ch, line });
      i++;
      continue;
    }

    if ('().,;[]?'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, line });
      i++;
      continue;
    }

    throw new Error(`Строка ${line}: Неизвестный символ "${ch}"`);
  }

  tokens.push({ type: 'eof', value: '', line });
  return tokens;
}

interface ProcDef {
  name: string;
  isFunction: boolean;
  params: string[];
  bodyStart: number;
  bodyEnd: number;
}

class CaseInsensitiveMap {
  private data = new Map<string, { origKey: string; val: any }>();

  set(key: string, val: any) {
    const k = key.toLowerCase();
    const existing = this.data.get(k);
    this.data.set(k, { origKey: existing ? existing.origKey : key, val });
  }
  get(key: string): any {
    return this.data.get(key.toLowerCase())?.val;
  }
  has(key: string): boolean {
    return this.data.has(key.toLowerCase());
  }
  entries(): [string, any][] {
    return Array.from(this.data.values()).map((e) => [e.origKey, e.val]);
  }
}

class BSLInterpreter {
  private pos = 0;
  public globalScope = new CaseInsensitiveMap();
  private procedures = new Map<string, ProcDef>();
  private stepCounter = 0;
  private maxSteps = 25000;

  constructor(
    private tokens: Token[],
    private state: InfobaseState,
    private onMessage: (val: any) => void
  ) {
    this.initGlobalEnvironment();
  }

  private tick(line: number) {
    this.stepCounter++;
    if (this.stepCounter > this.maxSteps) {
      throw new Error(`Строка ${line}: Превышен лимит итераций (возможно, бесконечный цикл).`);
    }
  }

  private initGlobalEnvironment() {
    // Справочники.*
    const catalogsProxy: any = {
      __type: 'СправочникиМенеджер',
      Номенклатура: this.makeCatalogManager('Номенклатура', this.state.nomenclature.map((n) => ({
        Код: n.code,
        Наименование: n.name,
        Артикул: n.article,
        ЦенаЗакупки: n.purchasePrice,
        ЦенаПродажи: n.salePrice,
        СтавкаНДС: n.vatRate,
      }))),
      Контрагенты: this.makeCatalogManager('Контрагенты', this.state.counterparties.map((c) => ({
        Код: c.code,
        Наименование: c.name,
        ИНН: c.inn,
        Роль: c.role,
      }))),
      Сотрудники: this.makeCatalogManager('Сотрудники', this.state.employees.map((e) => ({
        Код: e.code,
        Наименование: e.fullName,
        Должность: e.position,
        Оклад: e.salary,
      }))),
      Склады: this.makeCatalogManager('Склады', this.state.warehouses.map((w) => ({
        Код: w.code,
        Наименование: w.name,
        Ответственный: w.responsible,
      }))),
    };

    const documentsProxy: any = {
      __type: 'ДокументыМенеджер',
      ПоступлениеТоваровУслуг: this.makeDocManager('ПоступлениеТоваровУслуг'),
      РеализацияТоваровУслуг: this.makeDocManager('РеализацияТоваровУслуг'),
    };

    this.globalScope.set('Справочники', catalogsProxy);
    this.globalScope.set('Документы', documentsProxy);
  }

  private makeCatalogManager(name: string, items: Record<string, any>[]) {
    return {
      __type: `СправочникМенеджер.${name}`,
      НайтиПоНаименованию: (search: string) => {
        const found = items.find((it) => String(it.Наименование).toLowerCase().includes(String(search).toLowerCase()));
        return found ? wrap1CObject(`СправочникСсылка.${name}`, found) : wrapEmptyRef(`СправочникСсылка.${name}`);
      },
      НайтиПоКоду: (code: string) => {
        const found = items.find((it) => String(it.Код) === String(code));
        return found ? wrap1CObject(`СправочникСсылка.${name}`, found) : wrapEmptyRef(`СправочникСсылка.${name}`);
      },
      Выбрать: () => makeSelection(items),
      Количество: () => items.length,
    };
  }

  private makeDocManager(docType: string) {
    const docs = this.state.documents
      .filter((d) => d.docType === docType)
      .map((d) => ({
        Номер: d.number,
        Дата: d.date,
        Проведен: d.posted,
        СуммаДокумента: d.amount,
        СуммаНДС: d.vatAmount,
        Комментарий: d.comment,
      }));
    return {
      __type: `ДокументМенеджер.${docType}`,
      Выбрать: () => makeSelection(docs),
      НайтиПоНомеру: (num: string) => {
        const found = docs.find((d) => d.Номер.includes(String(num)));
        return found ? wrap1CObject(`ДокументСсылка.${docType}`, found) : wrapEmptyRef(`ДокументСсылка.${docType}`);
      },
    };
  }

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private next(): Token {
    const t = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private isKw(t: Token, ...words: string[]): boolean {
    if (t.type !== 'ident') return false;
    const lw = t.value.toLowerCase();
    return words.some((w) => w.toLowerCase() === lw);
  }

  private expectPunct(val: string) {
    const t = this.next();
    if (t.type !== 'punct' || t.value !== val) {
      throw new Error(`Строка ${t.line}: Ожидался символ "${val}", получено "${t.value}"`);
    }
  }

  private expectKw(...words: string[]) {
    const t = this.next();
    if (!this.isKw(t, ...words)) {
      throw new Error(`Строка ${t.line}: Ожидалось "${words[0]}", получено "${t.value}"`);
    }
  }

  public runProgram() {
    // Проход 1: регистрируем все Процедуры и Функции, а верхнеуровневые операторы запоминаем
    const topLevelRanges: [number, number][] = [];

    while (this.peek().type !== 'eof') {
      const t = this.peek();
      if (this.isKw(t, 'Процедура', 'Procedure', 'Функция', 'Function')) {
        const isFunc = this.isKw(t, 'Функция', 'Function');
        this.next();
        const nameTok = this.next();
        this.expectPunct('(');
        const params: string[] = [];
        while (!(this.peek().type === 'punct' && this.peek().value === ')') && this.peek().type !== 'eof') {
          if (this.isKw(this.peek(), 'Знач', 'Val')) this.next();
          const pName = this.next();
          params.push(pName.value);
          if (this.peek().type === 'op' && this.peek().value === '=') {
            this.next();
            this.parseExpression(this.globalScope); // default value skip
          }
          if (this.peek().type === 'punct' && this.peek().value === ',') this.next();
        }
        this.expectPunct(')');
        if (this.isKw(this.peek(), 'Экспорт', 'Export')) this.next();

        const bodyStart = this.pos;
        const endWord1 = isFunc ? 'КонецФункции' : 'КонецПроцедуры';
        const endWord2 = isFunc ? 'EndFunction' : 'EndProcedure';
        while (this.peek().type !== 'eof' && !this.isKw(this.peek(), endWord1, endWord2)) {
          this.next();
        }
        const bodyEnd = this.pos;
        if (this.peek().type === 'eof') {
          throw new Error(`Строка ${nameTok.line}: Не найдено "${endWord1}" для "${nameTok.value}"`);
        }
        this.next(); // consume КонецПроцедуры / КонецФункции
        if (this.peek().type === 'punct' && this.peek().value === ';') this.next();

        this.procedures.set(nameTok.value.toLowerCase(), {
          name: nameTok.value,
          isFunction: isFunc,
          params,
          bodyStart,
          bodyEnd,
        });
      } else {
        const stmtStart = this.pos;
        // Продвигаемся до следующей процедуры верхнего уровня или конца файла
        while (
          this.peek().type !== 'eof' &&
          !this.isKw(this.peek(), 'Процедура', 'Procedure', 'Функция', 'Function')
        ) {
          this.next();
        }
        const stmtEnd = this.pos;
        topLevelRanges.push([stmtStart, stmtEnd]);
      }
    }

    // Проход 2: выполняем верхнеуровневый код
    for (const [startIdx, endIdx] of topLevelRanges) {
      this.pos = startIdx;
      this.executeBlock(this.globalScope, endIdx);
    }
  }

  private executeBlock(scope: CaseInsensitiveMap, stopIndex: number, stopKeywords: string[] = []) {
    while (this.pos < stopIndex && this.peek().type !== 'eof') {
      if (stopKeywords.length > 0 && this.isKw(this.peek(), ...stopKeywords)) {
        return;
      }
      this.executeStatement(scope, stopIndex);
    }
  }

  private skipBlockUntil(stopIndex: number, targetKeywords: string[]) {
    let nestedIf = 0;
    let nestedLoop = 0;
    while (this.pos < stopIndex && this.peek().type !== 'eof') {
      const t = this.peek();
      if (nestedIf === 0 && nestedLoop === 0 && this.isKw(t, ...targetKeywords)) {
        return;
      }
      if (this.isKw(t, 'Если', 'If')) nestedIf++;
      else if (this.isKw(t, 'КонецЕсли', 'EndIf')) nestedIf = Math.max(0, nestedIf - 1);
      else if (this.isKw(t, 'Цикл', 'Do')) nestedLoop++;
      else if (this.isKw(t, 'КонецЦикла', 'EndDo')) nestedLoop = Math.max(0, nestedLoop - 1);
      this.next();
    }
  }

  private executeStatement(scope: CaseInsensitiveMap, stopIndex: number) {
    const t = this.peek();
    this.tick(t.line);

    if (t.type === 'punct' && t.value === ';') {
      this.next();
      return;
    }

    // Перем А, Б;
    if (this.isKw(t, 'Перем', 'Var')) {
      this.next();
      while (this.peek().type === 'ident') {
        const vName = this.next().value;
        if (this.isKw(this.peek(), 'Экспорт', 'Export')) this.next();
        if (!scope.has(vName)) scope.set(vName, undefined);
        if (this.peek().type === 'punct' && this.peek().value === ',') this.next();
        else break;
      }
      if (this.peek().type === 'punct' && this.peek().value === ';') this.next();
      return;
    }

    // Возврат [Выражение];
    if (this.isKw(t, 'Возврат', 'Return')) {
      this.next();
      let val: any = undefined;
      if (
        !(this.peek().type === 'punct' && this.peek().value === ';') &&
        !this.isKw(this.peek(), 'КонецФункции', 'КонецПроцедуры', 'КонецЕсли', 'Иначе', 'ИначеЕсли')
      ) {
        val = this.parseExpression(scope);
      }
      if (this.peek().type === 'punct' && this.peek().value === ';') this.next();
      throw new ReturnSignal(val);
    }

    if (this.isKw(t, 'Прервать', 'Break')) {
      this.next();
      if (this.peek().type === 'punct' && this.peek().value === ';') this.next();
      throw new BreakSignal();
    }

    if (this.isKw(t, 'Продолжить', 'Continue')) {
      this.next();
      if (this.peek().type === 'punct' && this.peek().value === ';') this.next();
      throw new ContinueSignal();
    }

    // Если ... Тогда ... [ИначеЕсли ... Тогда ...] [Иначе ...] КонецЕсли;
    if (this.isKw(t, 'Если', 'If')) {
      this.next();
      let branchExecuted = false;

      const cond = this.parseExpression(scope);
      this.expectKw('Тогда', 'Then');

      if (isTruthy1C(cond)) {
        branchExecuted = true;
        this.executeBlock(scope, stopIndex, ['ИначеЕсли', 'ElsIf', 'Иначе', 'Else', 'КонецЕсли', 'EndIf']);
      } else {
        this.skipBlockUntil(stopIndex, ['ИначеЕсли', 'ElsIf', 'Иначе', 'Else', 'КонецЕсли', 'EndIf']);
      }

      while (this.isKw(this.peek(), 'ИначеЕсли', 'ElsIf')) {
        this.next();
        const elifCond = this.parseExpression(scope);
        this.expectKw('Тогда', 'Then');
        if (!branchExecuted && isTruthy1C(elifCond)) {
          branchExecuted = true;
          this.executeBlock(scope, stopIndex, ['ИначеЕсли', 'ElsIf', 'Иначе', 'Else', 'КонецЕсли', 'EndIf']);
        } else {
          this.skipBlockUntil(stopIndex, ['ИначеЕсли', 'ElsIf', 'Иначе', 'Else', 'КонецЕсли', 'EndIf']);
        }
      }

      if (this.isKw(this.peek(), 'Иначе', 'Else')) {
        this.next();
        if (!branchExecuted) {
          this.executeBlock(scope, stopIndex, ['КонецЕсли', 'EndIf']);
        } else {
          this.skipBlockUntil(stopIndex, ['КонецЕсли', 'EndIf']);
        }
      }

      this.expectKw('КонецЕсли', 'EndIf');
      if (this.peek().type === 'punct' && this.peek().value === ';') this.next();
      return;
    }

    // Пока <Условие> Цикл ... КонецЦикла;
    if (this.isKw(t, 'Пока', 'While')) {
      this.next();
      const condPos = this.pos;
      // найдем конец цикла
      // Scan the condition without evaluating it: it may have side effects.
      while (this.peek().type !== 'eof' && !this.isKw(this.peek(), 'Цикл', 'Do')) this.next();
      this.expectKw('Цикл', 'Do');
      const bodyPos = this.pos;
      this.skipBlockUntil(stopIndex, ['КонецЦикла', 'EndDo']);
      const endLoopPos = this.pos;
      this.expectKw('КонецЦикла', 'EndDo');
      const afterLoopPos = this.pos;

      while (true) {
        this.tick(t.line);
        this.pos = condPos;
        const cVal = this.parseExpression(scope);
        this.expectKw('Цикл', 'Do');
        if (!isTruthy1C(cVal)) break;

        try {
          this.pos = bodyPos;
          this.executeBlock(scope, endLoopPos, ['КонецЦикла', 'EndDo']);
        } catch (sig) {
          if (sig instanceof BreakSignal) break;
          if (sig instanceof ContinueSignal) continue;
          throw sig;
        }
      }

      this.pos = afterLoopPos;
      if (this.peek().type === 'punct' && this.peek().value === ';') this.next();
      return;
    }

    // Для Каждого Элем Из Коллекция Цикл ... КонецЦикла ИЛИ Для Сч = А По Б Цикл ... КонецЦикла
    if (this.isKw(t, 'Для', 'For')) {
      this.next();
      if (this.isKw(this.peek(), 'Каждого', 'Each')) {
        this.next();
        const iterVar = this.next().value;
        this.expectKw('Из', 'In');
        const collection = this.parseExpression(scope);
        this.expectKw('Цикл', 'Do');
        const bodyPos = this.pos;
        this.skipBlockUntil(stopIndex, ['КонецЦикла', 'EndDo']);
        const endLoopPos = this.pos;
        this.expectKw('КонецЦикла', 'EndDo');
        const afterLoopPos = this.pos;

        const iterableItems = extractIterableItems(collection);
        for (const item of iterableItems) {
          this.tick(t.line);
          this.setVar(scope, iterVar, item);
          try {
            this.pos = bodyPos;
            this.executeBlock(scope, endLoopPos, ['КонецЦикла', 'EndDo']);
          } catch (sig) {
            if (sig instanceof BreakSignal) break;
            if (sig instanceof ContinueSignal) continue;
            throw sig;
          }
        }

        this.pos = afterLoopPos;
        if (this.peek().type === 'punct' && this.peek().value === ';') this.next();
        return;
      } else {
        const counterVar = this.next().value;
        const eq = this.next();
        if (eq.value !== '=') throw new Error(`Строка ${eq.line}: Ожидалось "=" в цикле Для`);
        const fromVal = Number(this.parseExpression(scope));
        this.expectKw('По', 'To');
        const toVal = Number(this.parseExpression(scope));
        this.expectKw('Цикл', 'Do');
        const bodyPos = this.pos;
        this.skipBlockUntil(stopIndex, ['КонецЦикла', 'EndDo']);
        const endLoopPos = this.pos;
        this.expectKw('КонецЦикла', 'EndDo');
        const afterLoopPos = this.pos;

        for (let idx = fromVal; idx <= toVal; idx++) {
          this.tick(t.line);
          this.setVar(scope, counterVar, idx);
          try {
            this.pos = bodyPos;
            this.executeBlock(scope, endLoopPos, ['КонецЦикла', 'EndDo']);
          } catch (sig) {
            if (sig instanceof BreakSignal) break;
            if (sig instanceof ContinueSignal) continue;
            throw sig;
          }
        }

        this.pos = afterLoopPos;
        if (this.peek().type === 'punct' && this.peek().value === ';') this.next();
        return;
      }
    }

    // Присваивание или вызов процедуры / метода
    this.parseAssignmentOrCall(scope);
    if (this.peek().type === 'punct' && this.peek().value === ';') {
      this.next();
    }
  }

  private setVar(scope: CaseInsensitiveMap, name: string, value: any) {
    if (scope !== this.globalScope && scope.has(name)) {
      scope.set(name, value);
    } else if (this.globalScope.has(name) && scope === this.globalScope) {
      this.globalScope.set(name, value);
    } else {
      scope.set(name, value);
    }
  }

  private getVar(scope: CaseInsensitiveMap, name: string): any {
    if (scope.has(name)) return scope.get(name);
    if (this.globalScope.has(name)) return this.globalScope.get(name);
    return undefined;
  }

  private parseAssignmentOrCall(scope: CaseInsensitiveMap) {
    const firstTok = this.peek();
    if (firstTok.type !== 'ident') {
      throw new Error(`Строка ${firstTok.line}: Неожиданное выражение "${firstTok.value}"`);
    }

    // Простой случай: ИмяПеременной = Выражение
    if (this.peek(1).type === 'op' && this.peek(1).value === '=') {
      const varName = this.next().value;
      this.next(); // '='
      const rhs = this.parseExpression(scope);
      this.setVar(scope, varName, rhs);
      return;
    }

    // Разбираем цепочку вида Объект.Свойство = Значение или Объект.Метод(...) или ВызовПроцедуры(...)
    const baseName = this.next().value;
    if (this.peek().type === 'punct' && this.peek().value === '(') {
      const args = this.parseArgList(scope);
      this.invokeFunctionOrBuiltIn(baseName, args, firstTok.line);
      return;
    }

    let currentObj = this.getVar(scope, baseName);
    while (this.peek().type === 'punct' && (this.peek().value === '.' || this.peek().value === '[')) {
      if (this.peek().value === '.') {
        this.next();
        const propName = this.next().value;
        if (this.peek().type === 'op' && this.peek().value === '=') {
          this.next();
          const val = this.parseExpression(scope);
          setObjectProperty(currentObj, propName, val);
          return;
        }
        if (this.peek().type === 'punct' && this.peek().value === '(') {
          const args = this.parseArgList(scope);
          currentObj = invokeObjectMethod(currentObj, propName, args, this.state, firstTok.line);
        } else {
          currentObj = getObjectProperty(currentObj, propName);
        }
      } else {
        this.next(); // '['
        const idxVal = this.parseExpression(scope);
        this.expectPunct(']');
        if (this.peek().type === 'op' && this.peek().value === '=') {
          this.next();
          const val = this.parseExpression(scope);
          setIndexedValue(currentObj, idxVal, val);
          return;
        }
        currentObj = getIndexedValue(currentObj, idxVal);
      }
    }
  }

  private parseArgList(scope: CaseInsensitiveMap): any[] {
    this.expectPunct('(');
    const args: any[] = [];
    while (!(this.peek().type === 'punct' && this.peek().value === ')') && this.peek().type !== 'eof') {
      if (this.peek().type === 'punct' && this.peek().value === ',') {
        args.push(undefined);
        this.next();
        continue;
      }
      args.push(this.parseExpression(scope));
      if (this.peek().type === 'punct' && this.peek().value === ',') {
        this.next();
      }
    }
    this.expectPunct(')');
    return args;
  }

  private parseExpression(scope: CaseInsensitiveMap): any {
    return this.parseOr(scope);
  }

  private parseOr(scope: CaseInsensitiveMap): any {
    let left = this.parseAnd(scope);
    while (this.isKw(this.peek(), 'Или', 'Or')) {
      this.next();
      const right = this.parseAnd(scope);
      left = isTruthy1C(left) || isTruthy1C(right);
    }
    return left;
  }

  private parseAnd(scope: CaseInsensitiveMap): any {
    let left = this.parseNot(scope);
    while (this.isKw(this.peek(), 'И', 'And')) {
      this.next();
      const right = this.parseNot(scope);
      left = isTruthy1C(left) && isTruthy1C(right);
    }
    return left;
  }

  private parseNot(scope: CaseInsensitiveMap): any {
    if (this.isKw(this.peek(), 'Не', 'Not')) {
      this.next();
      return !isTruthy1C(this.parseNot(scope));
    }
    return this.parseComparison(scope);
  }

  private parseComparison(scope: CaseInsensitiveMap): any {
    let left = this.parseAddSub(scope);
    while (this.peek().type === 'op' && ['=', '<>', '!=', '<', '>', '<=', '>='].includes(this.peek().value)) {
      const op = this.next().value;
      const right = this.parseAddSub(scope);
      if (op === '=') left = left === right;
      else if (op === '<>' || op === '!=') left = left !== right;
      else if (op === '<') left = Number(left) < Number(right);
      else if (op === '>') left = Number(left) > Number(right);
      else if (op === '<=') left = Number(left) <= Number(right);
      else if (op === '>=') left = Number(left) >= Number(right);
    }
    return left;
  }

  private parseAddSub(scope: CaseInsensitiveMap): any {
    let left = this.parseMulDiv(scope);
    while (this.peek().type === 'op' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value;
      const right = this.parseMulDiv(scope);
      if (op === '+') {
        if (typeof left === 'string' || typeof right === 'string') {
          left = format1CValue(left) + format1CValue(right);
        } else {
          left = Number((Number(left || 0) + Number(right || 0)).toFixed(6));
        }
      } else {
        left = Number((Number(left || 0) - Number(right || 0)).toFixed(6));
      }
    }
    return left;
  }

  private parseMulDiv(scope: CaseInsensitiveMap): any {
    let left = this.parseUnary(scope);
    while (this.peek().type === 'op' && ['*', '/', '%'].includes(this.peek().value)) {
      const op = this.next().value;
      const right = this.parseUnary(scope);
      if (op === '*') left = Number((Number(left || 0) * Number(right || 0)).toFixed(6));
      else if (op === '/') {
        const d = Number(right);
        if (d === 0) throw new Error('Деление на ноль в выражении 1С!');
        left = Number((Number(left || 0) / d).toFixed(6));
      } else {
        left = Number(left || 0) % Number(right || 1);
      }
    }
    return left;
  }

  private parseUnary(scope: CaseInsensitiveMap): any {
    if (this.peek().type === 'op' && this.peek().value === '-') {
      this.next();
      return -Number(this.parseUnary(scope));
    }
    if (this.peek().type === 'op' && this.peek().value === '+') {
      this.next();
      return Number(this.parseUnary(scope));
    }
    return this.parsePrimary(scope);
  }

  private parsePrimary(scope: CaseInsensitiveMap): any {
    const t = this.peek();

    // Тернарный оператор ?(Условие, Знач1, Знач2)
    if (t.type === 'punct' && t.value === '?') {
      this.next();
      this.expectPunct('(');
      const cond = this.parseExpression(scope);
      this.expectPunct(',');
      const vTrue = this.parseExpression(scope);
      this.expectPunct(',');
      const vFalse = this.parseExpression(scope);
      this.expectPunct(')');
      return isTruthy1C(cond) ? vTrue : vFalse;
    }

    if (t.type === 'punct' && t.value === '(') {
      this.next();
      const inner = this.parseExpression(scope);
      this.expectPunct(')');
      return inner;
    }

    if (t.type === 'number') {
      this.next();
      return Number(t.value);
    }

    if (t.type === 'string') {
      this.next();
      return t.value;
    }

    // Новый <Тип>[(Аргументы)]
    if (this.isKw(t, 'Новый', 'New')) {
      this.next();
      const typeNameTok = this.next();
      let ctorArgs: any[] = [];
      if (this.peek().type === 'punct' && this.peek().value === '(') {
        ctorArgs = this.parseArgList(scope);
      }
      return instantiate1CType(typeNameTok.value, ctorArgs);
    }

    if (this.isKw(t, 'Истина', 'True')) {
      this.next();
      return true;
    }
    if (this.isKw(t, 'Ложь', 'False')) {
      this.next();
      return false;
    }
    if (this.isKw(t, 'Неопределено', 'Undefined', 'Null')) {
      this.next();
      return undefined;
    }

    if (t.type === 'ident') {
      const name = this.next().value;
      let val: any;

      if (this.peek().type === 'punct' && this.peek().value === '(') {
        const args = this.parseArgList(scope);
        val = this.invokeFunctionOrBuiltIn(name, args, t.line);
      } else {
        val = this.getVar(scope, name);
      }

      // Цепочка свойств и методов .Свойство / .Метод() / [Индекс]
      while (this.peek().type === 'punct' && (this.peek().value === '.' || this.peek().value === '[')) {
        if (this.peek().value === '.') {
          this.next();
          const prop = this.next().value;
          if (this.peek().type === 'punct' && this.peek().value === '(') {
            const mArgs = this.parseArgList(scope);
            val = invokeObjectMethod(val, prop, mArgs, this.state, t.line);
          } else {
            val = getObjectProperty(val, prop);
          }
        } else {
          this.next();
          const idx = this.parseExpression(scope);
          this.expectPunct(']');
          val = getIndexedValue(val, idx);
        }
      }
      return val;
    }

    throw new Error(`Строка ${t.line}: Ошибка разбора выражения возле "${t.value}"`);
  }

  private invokeFunctionOrBuiltIn(name: string, args: any[], line: number): any {
    const low = name.toLowerCase();

    // Встроенные функции глобального контекста 1С
    if (low === 'сообщить' || low === 'message') {
      this.onMessage(args[0]);
      return undefined;
    }
    if (low === 'окр' || low === 'round') {
      const n = Number(args[0] || 0);
      const digits = args[1] !== undefined ? Number(args[1]) : 0;
      const factor = Math.pow(10, digits);
      return Math.round(n * factor) / factor;
    }
    if (low === 'цел' || low === 'int') {
      return Math.trunc(Number(args[0] || 0));
    }
    if (low === 'стрдлина' || low === 'strlen') {
      return String(args[0] ?? '').length;
    }
    if (low === 'сокрлп' || low === 'trimall') {
      return String(args[0] ?? '').trim();
    }
    if (low === 'врег' || low === 'upper') {
      return String(args[0] ?? '').toUpperCase();
    }
    if (low === 'нрег' || low === 'lower') {
      return String(args[0] ?? '').toLowerCase();
    }
    if (low === 'лев' || low === 'left') {
      return String(args[0] ?? '').slice(0, Number(args[1] || 0));
    }
    if (low === 'прав' || low === 'right') {
      const s = String(args[0] ?? '');
      const cnt = Number(args[1] || 0);
      return cnt <= 0 ? '' : s.slice(-cnt);
    }
    if (low === 'сред' || low === 'mid') {
      const s = String(args[0] ?? '');
      const startIdx = Math.max(1, Number(args[1] || 1)) - 1;
      const len = args[2] !== undefined ? Number(args[2]) : s.length;
      return s.slice(startIdx, startIdx + len);
    }
    if (low === 'стрзаменить' || low === 'strreplace') {
      return String(args[0] ?? '').split(String(args[1] ?? '')).join(String(args[2] ?? ''));
    }
    if (low === 'стрнайти' || low === 'strfind') {
      const idx = String(args[0] ?? '').indexOf(String(args[1] ?? ''));
      return idx === -1 ? 0 : idx + 1;
    }
    if (low === 'строка' || low === 'string') {
      return format1CValue(args[0]);
    }
    if (low === 'число' || low === 'number') {
      return Number(args[0] || 0);
    }
    if (low === 'текущаядата' || low === 'currentdate') {
      return '2026-11-12 12:00:00';
    }
    if (low === 'значениезаполнено' || low === 'valueisfilled') {
      const v = args[0];
      if (v === undefined || v === null || v === '' || v === 0 || v === false) return false;
      if (Array.isArray(v)) return v.length > 0;
      if (v && v.__emptyRef) return false;
      return true;
    }
    if (low === 'типзнч' || low === 'typeof') {
      const v = args[0];
      if (typeof v === 'number') return 'Число';
      if (typeof v === 'string') return 'Строка';
      if (typeof v === 'boolean') return 'Булево';
      if (Array.isArray(v)) return 'Массив';
      if (v && v.__type) return v.__type;
      return 'Неопределено';
    }
    if (low === 'формат' || low === 'format') {
      if (typeof args[0] === 'number') {
        return args[0].toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      return format1CValue(args[0]);
    }

    // Пользовательская процедура или функция
    const proc = this.procedures.get(low);
    if (!proc) {
      throw new Error(`Строка ${line}: Процедура или функция не обнаружена (${name})`);
    }

    const savedPos = this.pos;
    const localScope = new CaseInsensitiveMap();
    proc.params.forEach((p, idx) => {
      localScope.set(p, args[idx]);
    });

    let retVal: any = undefined;
    try {
      this.pos = proc.bodyStart;
      this.executeBlock(localScope, proc.bodyEnd);
    } catch (sig) {
      if (sig instanceof ReturnSignal) {
        retVal = sig.value;
      } else {
        this.pos = savedPos;
        throw sig;
      }
    }
    this.pos = savedPos;
    return retVal;
  }
}

// --- КОНСТРУКТОРЫ ТИПОВ 1С (Массив, Структура, Соответствие, ТаблицаЗначений, Запрос) ---

function instantiate1CType(typeName: string, args: any[]): any {
  const low = typeName.toLowerCase();

  if (low === 'массив' || low === 'array') {
    if (args.length > 0 && typeof args[0] === 'number') {
      return new Array(args[0]).fill(undefined);
    }
    return [];
  }

  if (low === 'структура' || low === 'structure') {
    const map = new CaseInsensitiveMap();
    if (typeof args[0] === 'string' && args[0].trim()) {
      const keys = args[0].split(',').map((k) => k.trim());
      keys.forEach((k, idx) => {
        map.set(k, args[idx + 1]);
      });
    }
    return { __type: 'Структура', __map: map };
  }

  if (low === 'соответствие' || low === 'map') {
    return { __type: 'Соответствие', __dict: new Map<any, any>() };
  }

  if (low === 'таблицазначений' || low === 'valuetable') {
    return {
      __type: 'ТаблицаЗначений',
      columns: [] as string[],
      rows: [] as CaseInsensitiveMap[],
    };
  }

  if (low === 'запрос' || low === 'query') {
    return {
      __type: 'Запрос',
      Текст: typeof args[0] === 'string' ? args[0] : '',
      Параметры: {} as Record<string, any>,
    };
  }

  throw new Error(`Тип не определен: "${typeName}"`);
}

function invokeObjectMethod(obj: any, methodName: string, args: any[], state: InfobaseState, line: number): any {
  if (!obj) {
    throw new Error(`Строка ${line}: Значение не является значением объектного типа (вызов .${methodName})`);
  }
  const low = methodName.toLowerCase();

  // Массив
  if (Array.isArray(obj)) {
    if (low === 'добавить' || low === 'add') {
      obj.push(args[0]);
      return undefined;
    }
    if (low === 'количество' || low === 'count') return obj.length;
    if (low === 'вграница' || low === 'ubound') return obj.length - 1;
    if (low === 'удалить' || low === 'delete') {
      obj.splice(Number(args[0]), 1);
      return undefined;
    }
    if (low === 'найти' || low === 'find') {
      const idx = obj.indexOf(args[0]);
      return idx === -1 ? undefined : idx;
    }
    if (low === 'очистить' || low === 'clear') {
      obj.length = 0;
      return undefined;
    }
  }

  // Структура
  if (obj.__type === 'Структура') {
    if (low === 'вставить' || low === 'insert') {
      obj.__map.set(String(args[0]), args[1]);
      return undefined;
    }
    if (low === 'количество' || low === 'count') {
      return obj.__map.entries().length;
    }
    if (low === 'свойство' || low === 'property') {
      return obj.__map.has(String(args[0]));
    }
  }

  // Соответствие
  if (obj.__type === 'Соответствие') {
    if (low === 'вставить' || low === 'insert') {
      obj.__dict.set(args[0], args[1]);
      return undefined;
    }
    if (low === 'получить' || low === 'get') {
      return obj.__dict.get(args[0]);
    }
    if (low === 'количество' || low === 'count') {
      return obj.__dict.size;
    }
  }

  // Запрос 1С
  if (obj.__type === 'Запрос') {
    if (low === 'установитьпараметр' || low === 'setparameter') {
      obj.Параметры[String(args[0])] = args[1];
      return undefined;
    }
    if (low === 'выполнить' || low === 'execute') {
      const qRes = execute1CQuery(obj.Текст, state, obj.Параметры);
      if (qRes.error) {
        throw new Error(`Ошибка в запросе: ${qRes.error}`);
      }
      return {
        __type: 'РезультатЗапроса',
        rows: qRes.rows,
        columns: qRes.columns,
        Пустой: () => qRes.rows.length === 0,
        Выбрать: () => makeSelection(qRes.rows),
        Выгрузить: () => {
          const vt = instantiate1CType('ТаблицаЗначений', []);
          vt.columns = [...qRes.columns];
          vt.rows = qRes.rows.map((r) => {
            const m = new CaseInsensitiveMap();
            for (const [k, v] of Object.entries(r)) m.set(k, v);
            return m;
          });
          return vt;
        },
      };
    }
  }

  // ТаблицаЗначений
  if (obj.__type === 'ТаблицаЗначений') {
    if (low === 'добавить' || low === 'add') {
      const row = new CaseInsensitiveMap();
      for (const c of obj.columns) row.set(c, undefined);
      obj.rows.push(row);
      return { __type: 'СтрокаТаблицыЗначений', __map: row };
    }
    if (low === 'количество' || low === 'count') {
      return obj.rows.length;
    }
    if (low === 'итог' || low === 'total') {
      const colName = String(args[0]);
      return obj.rows.reduce((sum: number, r: CaseInsensitiveMap) => sum + Number(r.get(colName) || 0), 0);
    }
  }

  // Колонки ТаблицыЗначений
  if (obj.__type === 'КоллекцияКолонокТЗ') {
    if (low === 'добавить' || low === 'add') {
      obj.vt.columns.push(String(args[0]));
      return undefined;
    }
  }

  // Прямой вызов функции на объекте (Выборка.Следующий(), Справочники.Номенклатура.НайтиПоНаименованию() и т.д.)
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === low && typeof obj[k] === 'function') {
      return obj[k](...args);
    }
  }

  throw new Error(`Строка ${line}: Метод объекта не обнаружен (${methodName})`);
}

function getObjectProperty(obj: any, propName: string): any {
  if (!obj) return undefined;
  if (obj.__type === 'Структура' || obj.__type === 'СтрокаТаблицыЗначений' || obj.__type === 'ОбъектБД') {
    return obj.__map.get(propName);
  }
  if (obj.__type === 'ТаблицаЗначений' && (propName.toLowerCase() === 'колонки' || propName.toLowerCase() === 'columns')) {
    return { __type: 'КоллекцияКолонокТЗ', vt: obj };
  }
  const low = propName.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === low) return obj[k];
  }
  return undefined;
}

function setObjectProperty(obj: any, propName: string, val: any) {
  if (!obj) throw new Error(`Попытка присвоить свойство "${propName}" неопределенному значению`);
  if (obj.__type === 'Структура' || obj.__type === 'СтрокаТаблицыЗначений' || obj.__type === 'ОбъектБД') {
    obj.__map.set(propName, val);
    return;
  }
  const low = propName.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === low) {
      obj[k] = val;
      return;
    }
  }
  obj[propName] = val;
}

function getIndexedValue(obj: any, idx: any): any {
  if (Array.isArray(obj)) return obj[Number(idx)];
  if (obj && obj.__type === 'Соответствие') return obj.__dict.get(idx);
  if (obj && obj.__type === 'Структура') return obj.__map.get(String(idx));
  if (obj && obj.__type === 'ТаблицаЗначений') {
    const r = obj.rows[Number(idx)];
    return r ? { __type: 'СтрокаТаблицыЗначений', __map: r } : undefined;
  }
  return undefined;
}

function setIndexedValue(obj: any, idx: any, val: any) {
  if (Array.isArray(obj)) {
    obj[Number(idx)] = val;
    return;
  }
  if (obj && obj.__type === 'Соответствие') {
    obj.__dict.set(idx, val);
    return;
  }
  if (obj && obj.__type === 'Структура') {
    obj.__map.set(String(idx), val);
  }
}

function extractIterableItems(collection: any): any[] {
  if (Array.isArray(collection)) return collection;
  if (collection && collection.__type === 'ТаблицаЗначений') {
    return collection.rows.map((r: CaseInsensitiveMap) => ({ __type: 'СтрокаТаблицыЗначений', __map: r }));
  }
  if (collection && collection.__type === 'Структура') {
    return collection.__map.entries().map(([k, v]: [string, any]) => {
      const kv = new CaseInsensitiveMap();
      kv.set('Ключ', k);
      kv.set('Значение', v);
      return { __type: 'КлючИЗначение', __map: kv };
    });
  }
  if (collection && collection.__type === 'Соответствие') {
    return Array.from(collection.__dict.entries() as Iterable<[any, any]>).map(([k, v]: [any, any]) => {
      const kv = new CaseInsensitiveMap();
      kv.set('Ключ', k);
      kv.set('Значение', v);
      return { __type: 'КлючИЗначение', __map: kv };
    });
  }
  return [];
}

function wrap1CObject(typeTitle: string, fields: Record<string, any>) {
  const map = new CaseInsensitiveMap();
  for (const [k, v] of Object.entries(fields)) map.set(k, v);
  return {
    __type: 'ОбъектБД',
    __refTitle: fields.Наименование || fields.Номер || typeTitle,
    __map: map,
    Пустая: () => false,
  };
}

function wrapEmptyRef(typeTitle: string) {
  return {
    __type: typeTitle,
    __emptyRef: true,
    Пустая: () => true,
  };
}

function makeSelection(rows: Record<string, any>[]) {
  let cursor = -1;
  const selObj: any = {
    __type: 'ВыборкаИзРезультатаЗапроса',
    Следующий: () => {
      cursor++;
      if (cursor < rows.length) {
        const current = rows[cursor];
        for (const [k, v] of Object.entries(current)) {
          selObj[k] = v;
        }
        return true;
      }
      return false;
    },
    Количество: () => rows.length,
  };
  return selObj;
}

function isTruthy1C(val: any): boolean {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'number') return val !== 0;
  return Boolean(val);
}

export function format1CValue(val: any): string {
  if (val === undefined || val === null) return 'Неопределено';
  if (typeof val === 'boolean') return val ? 'Истина' : 'Ложь';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return `Массив (${val.length} элем.)`;
  if (val.__emptyRef) return '<Пустая ссылка>';
  if (val.__refTitle) return String(val.__refTitle);
  if (val.__type) return val.__type;
  return String(val);
}

function summarizeDebugValue(val: any): string {
  if (Array.isArray(val)) {
    return `[${val.map((x) => format1CValue(x)).join(', ')}] (Массив[${val.length}])`;
  }
  if (val && val.__type === 'Структура') {
    const pairs = val.__map.entries().map(([k, v]: [string, any]) => `${k}: ${format1CValue(v)}`);
    return `{ ${pairs.join(', ')} } (Структура)`;
  }
  if (val && val.__type === 'ТаблицаЗначений') {
    return `ТаблицаЗначений (строк: ${val.rows.length}, колонок: ${val.columns.length})`;
  }
  return format1CValue(val);
}
