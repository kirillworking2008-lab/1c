import React, { useState } from 'react';
import { AppMode, InfobaseState } from '../types/oneC';
import {
  Database,
  Play,
  Wrench,
  RotateCcw,
  Download,
  Upload,
  GraduationCap,
  FolderOpen,
  Info,
  Tablet,
} from 'lucide-react';
import { ACADEMY_TASKS } from '../data/academyTasks';

interface LauncherScreenProps {
  state: InfobaseState;
  onSelectMode: (mode: AppMode) => void;
  onResetDatabase: () => void;
  onExportDatabase: () => void;
  onImportDatabase: (jsonText: string) => void;
  onOpenAcademy: () => void;
}

export const LauncherScreen: React.FC<LauncherScreenProps> = ({
  state,
  onSelectMode,
  onResetDatabase,
  onExportDatabase,
  onImportDatabase,
  onOpenAcademy,
}) => {
  const [selectedBaseIdx, setSelectedBaseIdx] = useState(0);
  const [confirmReset, setConfirmReset] = useState(false);

  const bases = [
    {
      name: state.infobaseName,
      path: 'File="/data/user/0/ru.simulator1c.enterprise83/databases/Accounting30";',
      config: 'Бухгалтерия предприятия, ред. 3.0.148',
      docsCount: state.documents.length,
    },
    {
      name: 'Демо-песочница разработчика 1С (BSL + Консоль запросов)',
      path: 'File="/data/user/0/ru.simulator1c.enterprise83/databases/DevSandbox";',
      config: 'Управляемое приложение (Такси) + Конфигуратор',
      docsCount: state.documents.length,
    },
  ];

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        onImportDatabase(reader.result);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="h-full w-full bg-[#e6e6e6] flex items-center justify-center p-4 select-none">
      {/* Классическое окно запуска 1С:Предприятие 8.3 */}
      <div className="w-full max-w-[820px] bg-[#f4f4f4] border border-[#8e8e8e] shadow-2xl rounded-[3px] overflow-hidden flex flex-col">
        {/* Заголовок окна Windows / 1С */}
        <div className="bg-gradient-to-r from-[#ffdf6b] via-[#ffe999] to-[#f8d24a] border-b border-[#cfa828] px-3.5 py-2 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-6 h-6 rounded-[2px] bg-[#d62828] text-[#ffdf6b] font-extrabold text-[13px] flex items-center justify-center shadow-sm border border-[#9e1b1b]">
              1С
            </div>
            <div>
              <div className="font-bold text-[14px] text-[#2b2100] leading-tight">
                Запуск 1С:Предприятия — Платформа {state.version}
              </div>
              <div className="text-[11px] text-[#5c4800] flex items-center gap-1.5">
                <Tablet className="w-3 h-3" />
                Адаптировано для Android-планшета (клавиатура + мышь + тач)
              </div>
            </div>
          </div>

          <button
            onClick={onOpenAcademy}
            className="flex items-center gap-1.5 px-3 py-1 rounded bg-[#2b579a] hover:bg-[#1e3f73] text-white text-[12px] font-semibold shadow-sm transition-colors"
          >
            <GraduationCap className="w-4 h-4" />
            Академия 1С ({state.completedTaskIds.length}/{ACADEMY_TASKS.length} заданий • {state.xpTotal} XP)
          </button>
        </div>

        {/* Основная часть окна: слева список баз, справа кнопки запуска */}
        <div className="p-4 flex flex-col md:flex-row gap-4">
          {/* Левая колонка: список информационных баз */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="text-[12px] text-[#444] mb-1.5 font-medium flex items-center justify-between">
              <span>Информационные базы:</span>
              <span className="text-[11px] text-[#666]">Пользователь: {state.currentUser}</span>
            </div>

            <div className="bg-white border border-[#a6a6a6] h-[230px] overflow-y-auto p-1">
              {bases.map((b, idx) => {
                const active = selectedBaseIdx === idx;
                return (
                  <div
                    key={idx}
                    onClick={() => setSelectedBaseIdx(idx)}
                    onDoubleClick={() => onSelectMode(idx === 1 ? 'configurator' : 'enterprise')}
                    className={`px-2.5 py-2 mb-0.5 cursor-pointer border flex items-start gap-2.5 ${
                      active
                        ? 'bg-[#ffefb4] border-[#dfb429]'
                        : 'bg-white border-transparent hover:bg-[#fff9e4]'
                    }`}
                  >
                    <Database className="w-4 h-4 text-[#b8860b] shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-[13px] text-[#1f1f1f] truncate">{b.name}</div>
                      <div className="text-[11.5px] text-[#666] mt-0.5">{b.config}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Путь к выбранной ИБ внизу как в настоящей 1С */}
            <div className="mt-2.5 bg-[#ebebeb] border border-[#cccccc] px-2.5 py-1.5 text-[11.5px] text-[#444] font-mono truncate flex items-center gap-1.5">
              <FolderOpen className="w-3.5 h-3.5 text-[#777] shrink-0" />
              <span className="truncate">{bases[selectedBaseIdx].path}</span>
            </div>

            {/* Статистика базы */}
            <div className="mt-2.5 grid grid-cols-4 gap-2 text-center">
              <div className="bg-white border border-[#d4d4d4] py-1.5 px-2 rounded-[2px]">
                <div className="text-[11px] text-[#666]">Контрагентов</div>
                <div className="font-bold text-[14px] text-[#222]">{state.counterparties.length}</div>
              </div>
              <div className="bg-white border border-[#d4d4d4] py-1.5 px-2 rounded-[2px]">
                <div className="text-[11px] text-[#666]">Номенклатуры</div>
                <div className="font-bold text-[14px] text-[#222]">{state.nomenclature.length}</div>
              </div>
              <div className="bg-white border border-[#d4d4d4] py-1.5 px-2 rounded-[2px]">
                <div className="text-[11px] text-[#666]">Документов</div>
                <div className="font-bold text-[14px] text-[#222]">{state.documents.length}</div>
              </div>
              <div className="bg-white border border-[#d4d4d4] py-1.5 px-2 rounded-[2px]">
                <div className="text-[11px] text-[#666]">Проводок Дт/Кт</div>
                <div className="font-bold text-[14px] text-[#106e33]">{state.accountingEntries.length}</div>
              </div>
            </div>
          </div>

          {/* Правая колонка: кнопки "1С:Предприятие" и "Конфигуратор" */}
          <div className="w-full md:w-[235px] flex flex-col gap-2 shrink-0 pt-5">
            <button
              onClick={() => onSelectMode('enterprise')}
              className="btn-1c-primary py-2.5 px-4 justify-start text-[13.5px]"
            >
              <Play className="w-4 h-4 fill-[#222]" />
              <span>1С:Предприятие</span>
            </button>

            <button
              onClick={() => onSelectMode('configurator')}
              className="btn-1c py-2.5 px-4 justify-start font-semibold text-[13.5px]"
            >
              <Wrench className="w-4 h-4 text-[#4b5563]" />
              <span>Конфигуратор</span>
            </button>

            <div className="border-t border-[#d0d0d0] my-1.5" />

            <button
              onClick={onOpenAcademy}
              className="btn-1c py-2 px-3 justify-start text-[#1d4ed8] font-medium"
            >
              <GraduationCap className="w-4 h-4" />
              <span>Учебник и Задания (12)</span>
            </button>

            <button onClick={onExportDatabase} className="btn-1c py-1.5 px-3 justify-start">
              <Download className="w-3.5 h-3.5 text-[#444]" />
              <span>Выгрузить ИБ (.dt / .json)</span>
            </button>

            <label className="btn-1c py-1.5 px-3 justify-start cursor-pointer">
              <Upload className="w-3.5 h-3.5 text-[#444]" />
              <span>Загрузить ИБ из файла</span>
              <input type="file" accept=".json,.dt" onChange={handleFileUpload} className="hidden" />
            </label>

            {!confirmReset ? (
              <button
                onClick={() => setConfirmReset(true)}
                className="btn-1c py-1.5 px-3 justify-start text-[#991b1b]"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Сбросить демо-базу</span>
              </button>
            ) : (
              <div className="bg-[#fff1f2] border border-[#f43f5e] p-2 rounded-[2px] text-[11.5px]">
                <div className="font-semibold text-[#9f1239] mb-1.5">Сбросить базу к исходной?</div>
                <div className="flex gap-1.5">
                  <button
                    onClick={() => {
                      onResetDatabase();
                      setConfirmReset(false);
                    }}
                    className="px-2 py-0.5 bg-[#e11d48] text-white rounded-[2px] font-medium"
                  >
                    Да, сбросить
                  </button>
                  <button
                    onClick={() => setConfirmReset(false)}
                    className="px-2 py-0.5 bg-white border border-gray-300 rounded-[2px]"
                  >
                    Отмена
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Подсказка горячих клавиш для планшета с клавиатурой */}
        <div className="bg-[#eaeaea] border-t border-[#cccccc] px-4 py-2 text-[11.5px] text-[#555] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5 text-[#b48400]" />
            <span>
              <b>1С:Предприятие</b> — работа бухгалтера, первичные документы, проводки, ОСВ.{' '}
              <b>Конфигуратор</b> — дерево метаданных, код BSL и консоль запросов.
            </span>
          </div>
          <span className="font-mono text-[11px] bg-white px-2 py-0.5 border border-[#ccc]">
            Горячие клавиши: F5 (Запуск) • F7 (Обновить БД) • Insert (Создать)
          </span>
        </div>
      </div>
    </div>
  );
};
