import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSessionDetail } from './useSessionDetail';
import { getMessages, getSession, getTriage } from './api';

vi.mock('./api',()=>({getMessages:vi.fn(),getSession:vi.fn(),getTriage:vi.fn()}));
afterEach(()=>{cleanup();vi.useRealTimers();vi.clearAllMocks();});

it('refreshes incoming WhatsApp replies within two seconds while the chat is open',async()=>{
  vi.useFakeTimers();
  vi.mocked(getSession).mockResolvedValue({sessionId:'visit',startedAt:new Date().toISOString(),patient:{name:null,age:null},conditions:[],staffHandling:true});
  vi.mocked(getTriage).mockResolvedValue([]);
  const nurse={id:'nurse',role:'nurse',content:'halo kak',createdAt:new Date().toISOString()};
  const patient={id:'patient',role:'patient',content:'halo',createdAt:new Date().toISOString()};
  vi.mocked(getMessages).mockResolvedValueOnce([nurse]).mockResolvedValue([nurse,patient]);
  const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
  const wrapper=({children}:{children:ReactNode})=>createElement(QueryClientProvider,{client},children);
  const {result,unmount}=renderHook(()=>useSessionDetail('visit'),{wrapper});
  await act(async()=>{await vi.advanceTimersByTimeAsync(1);});
  expect(result.current.messages.data).toEqual([nurse]);
  await act(async()=>{await vi.advanceTimersByTimeAsync(2000);});
  expect(result.current.messages.data).toEqual([nurse,patient]);
  unmount();client.clear();
});
