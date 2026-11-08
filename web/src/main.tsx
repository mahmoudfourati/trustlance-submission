import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createBrowserRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import './index.css'
import { Layout } from './components/Layout'
import { WalletProvider } from './lib/WalletProvider'
import { decodeContractError } from './lib/errors'
import { Arbitration } from './pages/Arbitration'
import { Balances } from './pages/Balances'
import { CreateProject } from './pages/CreateProject'
import { Dashboard } from './pages/Dashboard'
import { NotFound } from './pages/NotFound'
import { ProjectPage } from './pages/ProjectPage'
import { RouteError } from './pages/RouteError'
import { installTestWallet } from './lib/testWallet'

installTestWallet()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: true,
      // A contract revert (e.g. UnknownProject) is final; only retry network-level failures.
      retry: (failureCount, error) => failureCount < 1 && decodeContractError(error) === undefined,
    },
  },
})

const router = createBrowserRouter([
  {
    path: '/',
    Component: Layout,
    ErrorBoundary: RouteError,
    children: [
      { index: true, Component: Dashboard },
      { path: 'projects/new', Component: CreateProject },
      { path: 'projects/:id', Component: ProjectPage },
      { path: 'balances', Component: Balances },
      { path: 'arbitration', Component: Arbitration },
      { path: '*', Component: NotFound },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <WalletProvider>
        <RouterProvider router={router} />
      </WalletProvider>
    </QueryClientProvider>
  </StrictMode>,
)
