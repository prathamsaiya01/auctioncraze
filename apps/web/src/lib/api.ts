import axios from 'axios';

export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4001/api/v1';

export const TOKEN_STORAGE_KEY = 'auctioncraze_guest_token';
export const SESSION_STORAGE_KEY = 'auctioncraze_guest_session';

export const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  }
});

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const message = error.response?.data?.message || error.message || 'Request failed';
    const err = new Error(message) as Error & { code?: string; status?: number };
    err.code = error.response?.data?.code;
    err.status = error.response?.status;
    return Promise.reject(err);
  }
);
