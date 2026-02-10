import { NextRequest, NextResponse } from 'next/server'

const AUTH_REALM = 'Infinimap'

function unauthorized() {
  return new NextResponse('Authentication required.', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${AUTH_REALM}", charset="UTF-8"`,
      'Cache-Control': 'no-store',
    },
  })
}

export function middleware(request: NextRequest) {
  const username = process.env.BASIC_AUTH_USER
  const password = process.env.BASIC_AUTH_PASSWORD

  // Auth is enabled only when both variables are present.
  if (!username || !password) {
    return NextResponse.next()
  }

  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Basic ')) {
    return unauthorized()
  }

  let decoded = ''
  try {
    decoded = atob(authHeader.slice('Basic '.length))
  } catch {
    return unauthorized()
  }

  const separatorIndex = decoded.indexOf(':')
  if (separatorIndex < 0) {
    return unauthorized()
  }

  const inputUsername = decoded.slice(0, separatorIndex)
  const inputPassword = decoded.slice(separatorIndex + 1)

  if (inputUsername !== username || inputPassword !== password) {
    return unauthorized()
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
