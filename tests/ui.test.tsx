import React from 'react';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {App} from '../src/App';

beforeEach(()=>{localStorage.clear();});
afterEach(()=>cleanup());
describe('учебное приложение',()=>{
 it('создаёт контрагента и сохраняет его после перезапуска',()=>{
  const view=render(<App/>);
  fireEvent.click(screen.getByRole('button',{name:'Предприятие'}));
  fireEvent.click(screen.getByRole('button',{name:'Контрагенты'}));
  fireEvent.change(screen.getByPlaceholderText('Наименование'),{target:{value:'ООО Тест'}});
  fireEvent.change(screen.getByPlaceholderText('ИНН (10 или 12 цифр)'),{target:{value:'1234567890'}});
  fireEvent.click(screen.getByRole('button',{name:'+ Создать'}));
  expect(screen.getByText('Контрагент сохранён.')).toBeTruthy();
  expect(screen.getByText('ООО Тест')).toBeTruthy();
  view.unmount(); render(<App/>);
  fireEvent.click(screen.getByRole('button',{name:'Предприятие'}));
  fireEvent.click(screen.getByRole('button',{name:'Контрагенты'}));
  expect(screen.getByText('ООО Тест')).toBeTruthy();
 });
 it('проводит документ с двумя строками и показывает движения',()=>{
  render(<App/>); fireEvent.click(screen.getByRole('button',{name:'Предприятие'}));
  fireEvent.click(screen.getByRole('button',{name:'Документы'}));
  fireEvent.click(screen.getByRole('button',{name:'+ Добавить строку'}));
  fireEvent.click(screen.getByRole('button',{name:'+ Добавить строку'}));
  fireEvent.click(screen.getByRole('button',{name:'Провести документ'}));
  expect(screen.getByText('Документ проведён. Проводки показаны под журналом.')).toBeTruthy();
  expect(screen.getByText('Движения документа · Дт / Кт')).toBeTruthy();
  expect(screen.getAllByText('41.01').length).toBeGreaterThan(0);
 });
 it('выполняет запрос и сохраняет прогресс урока',()=>{
  render(<App/>); fireEvent.click(screen.getByRole('button',{name:'Предприятие'}));
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button',{name:'Обучение'}));
  fireEvent.click(screen.getByText('Первый запрос 1С: ВЫБРАТЬ и фильтрация ГДЕ'));
  fireEvent.click(screen.getByRole('button',{name:'Открыть шаблон запроса →'}));
  fireEvent.click(screen.getByRole('button',{name:'▶ Выполнить запрос'}));
  expect(screen.getByText(/Отобрано строк: 2/)).toBeTruthy();
  fireEvent.click(within(screen.getByRole('navigation')).getByRole('button',{name:'Обучение'}));
  fireEvent.click(screen.getByRole('button',{name:'Проверить задание'}));
  expect(screen.getByText(/Запрос выполнен верно/)).toBeTruthy();
  expect(JSON.parse(localStorage.getItem('learning-1c-v1')!).completedTaskIds).toContain('task-06-query-select');
 });
 it('отменяет проведение документа и обновляет движения',()=>{
  render(<App/>); fireEvent.click(screen.getByRole('button',{name:'Предприятие'}));
  fireEvent.click(screen.getByRole('button',{name:'Документы'}));
  fireEvent.click(screen.getByRole('button',{name:'+ Добавить строку'}));
  fireEvent.click(screen.getByRole('button',{name:'Провести документ'}));
  fireEvent.click(screen.getByRole('button',{name:'Отменить проведение'}));
  expect(screen.getByText('Проведение отменено.')).toBeTruthy();
  expect(screen.getByRole('button',{name:'Провести выбранный'})).toBeTruthy();
  expect(screen.getByText('Проводок нет.')).toBeTruthy();
 });

});
