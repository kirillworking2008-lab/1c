export type AppMode = 'launcher' | 'enterprise' | 'configurator';

// --- СПРАВОЧНИКИ (Catalogs) ---

export interface Organization {
  id: string;
  code: string;
  name: string;
  fullName: string;
  inn: string;
  kpp: string;
  taxSystem: 'ОСНО' | 'УСН (Доходы 6%)' | 'УСН (Доходы-Расходы 15%)';
}

export interface Counterparty {
  id: string;
  code: string;
  name: string;
  inn: string;
  kpp: string;
  type: 'Юридическое лицо' | 'Физическое лицо' | 'ИП';
  role: 'Покупатель' | 'Поставщик' | 'Прочее';
  phone: string;
  contract: string;
}

export interface Nomenclature {
  id: string;
  code: string;
  article: string;
  name: string;
  type: 'Товар' | 'Услуга' | 'Материал';
  unit: 'шт' | 'усл' | 'кг' | 'компл' | 'мес';
  vatRate: '20%' | '10%' | 'Без НДС';
  purchasePrice: number;
  salePrice: number;
  accountCode: string; // 41.01, 10.01, 20.01
}

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  type: 'Оптовый склад' | 'Розничный магазин';
  responsible: string;
}

export interface Employee {
  id: string;
  code: string;
  fullName: string;
  position: string;
  department: string;
  salary: number;
  inn: string;
  hireDate: string;
}

// --- ПЛАН СЧЕТОВ БУХГАЛТЕРСКОГО УЧЕТА РФ ---

export interface ChartAccount {
  code: string;        // '01', '10.01', '41.01', '50.01', '51', '60.01', '62.01', '68.02', '70', '80', '90.01.1', '90.02.1', '90.03', '99'
  name: string;
  kind: 'Активный' | 'Пассивный' | 'Активно-пассивный';
  subconto1?: string;  // Номенклатура / Контрагенты / Сотрудники / СтатьиДДС
  subconto2?: string;  // Склады / Договоры
  isQuantitative?: boolean;
}

// --- ДОКУМЕНТЫ (Documents) ---

export type DocumentType =
  | 'ПоступлениеТоваровУслуг'
  | 'РеализацияТоваровУслуг'
  | 'ПриходныйКассовыйОрдер'
  | 'РасходныйКассовыйОрдер'
  | 'ПоступлениеНаРасчетныйСчет'
  | 'СписаниеСРасчетногоСчета'
  | 'НачислениеЗарплаты'
  | 'ОперацияБух';

export interface DocumentLine {
  id: string;
  nomenclatureId: string;
  nomenclatureName: string;
  quantity: number;
  price: number;
  amount: number;
  vatRate: '20%' | '10%' | 'Без НДС';
  vatAmount: number;
  total: number;
  accountCode: string; // счет учета 41.01 / 10.01 / 26
}

export interface ManualAccountingLine {
  id: string;
  debitAccount: string;
  debitSubconto: string;
  creditAccount: string;
  creditSubconto: string;
  amount: number;
  content: string;
}

export interface Doc1C {
  id: string;
  docType: DocumentType;
  number: string;
  date: string; // YYYY-MM-DD HH:mm:ss
  posted: boolean; // Проведен
  markedForDeletion: boolean;
  organizationId: string;
  counterpartyId?: string;
  warehouseId?: string;
  employeeId?: string;
  amount: number;
  vatAmount: number;
  comment: string;
  cashFlowArticle?: string;
  lines: DocumentLine[];
  manualEntries?: ManualAccountingLine[];
}

// --- РЕГИСТР БУХГАЛТЕРСКИХ ПРОВОДОК И РЕГИСТР НАКОПЛЕНИЯ ---

export interface AccountingEntry {
  id: string;
  docId: string;
  docType: DocumentType;
  docPresentation: string;
  period: string; // YYYY-MM-DD
  debitAccount: string;
  debitSubconto1: string;
  debitSubconto2?: string;
  creditAccount: string;
  creditSubconto1: string;
  creditSubconto2?: string;
  quantityDebit?: number;
  quantityCredit?: number;
  amount: number;
  content: string;
}

export interface StockMovement {
  id: string;
  docId: string;
  docPresentation: string;
  period: string;
  movementType: 'Приход' | 'Расход';
  warehouseId: string;
  warehouseName: string;
  nomenclatureId: string;
  nomenclatureName: string;
  quantity: number;
  costAmount: number;
}

// --- МЕТАДАННЫЕ И МОДУЛИ КОНФИГУРАТОРА ---

export interface ConfigModule {
  id: string;
  objectType: 'ОбщийМодуль' | 'Справочник' | 'Документ' | 'Обработка' | 'Отчет';
  objectName: string;
  moduleType: 'МодульОбъекта' | 'МодульМенеджера' | 'МодульФормы' | 'МодульКоманды' | 'ОбщийМодуль';
  title: string;
  code: string;
  readOnly?: boolean;
}

export interface CustomCatalogMeta {
  name: string;
  synonym: string;
  attributes: { name: string; type: 'Строка' | 'Число' | 'Дата' | 'Булево' }[];
}

export interface CustomDocumentMeta {
  name: string;
  synonym: string;
  attributes: { name: string; type: 'Строка' | 'Число' | 'Дата' | 'СправочникСсылка' }[];
  postingCode: string;
}

// --- ЗАДАНИЯ АКАДЕМИИ 1С ---

export type TaskCategory = 'Бухгалтерия и Документы' | 'Язык запросов 1С' | 'Программирование BSL' | 'Конфигуратор и Архитектура';

export interface AcademyTask {
  id: string;
  order: number;
  title: string;
  category: TaskCategory;
  difficulty: 'Начальный' | 'Средний' | 'Продвинутый';
  xp: number;
  theory: string;
  objective: string;
  hints: string[];
  targetMode: 'enterprise' | 'configurator';
  starterCode?: string;
  starterQuery?: string;
  checkType: 'state' | 'bsl_output' | 'query_result' | 'module_code';
}

// --- ПОЛНОЕ СОСТОЯНИЕ БАЗЫ ДАННЫХ 1С ---

export interface InfobaseState {
  version: string;
  infobaseName: string;
  currentUser: string;
  organizations: Organization[];
  counterparties: Counterparty[];
  nomenclature: Nomenclature[];
  warehouses: Warehouse[];
  employees: Employee[];
  chartOfAccounts: ChartAccount[];
  documents: Doc1C[];
  accountingEntries: AccountingEntry[];
  stockMovements: StockMovement[];
  modules: ConfigModule[];
  customCatalogs: CustomCatalogMeta[];
  customDocuments: CustomDocumentMeta[];
  completedTaskIds: string[];
  xpTotal: number;
  messageLog: { id: string; time: string; text: string; type: 'info' | 'warning' | 'error' | 'success' }[];
}
