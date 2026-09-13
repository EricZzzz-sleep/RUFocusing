import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../../desktop/src/styles.css'
import './web.css'
import App from './App'
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
