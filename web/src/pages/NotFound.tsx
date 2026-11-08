import { Link } from 'react-router'
import { buttonClass } from '../components/styles'
import { Card } from '../components/ui'

export function NotFound() {
  return (
    <Card className="mx-auto max-w-md text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <Link to="/" className={`${buttonClass.secondary} mt-4`}>
        Back to dashboard
      </Link>
    </Card>
  )
}
