import type { MetadataRoute } from 'next'

/**
 * Lets TimeHero be added to a phone's home screen. On iPhone and iPad that is
 * not optional for notifications: iOS (16.4 and later) delivers Web Push only
 * to a site opened from the home screen.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'TimeHero',
    short_name: 'TimeHero',
    description: 'Time and leave.',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [{ src: '/favicon.ico', sizes: 'any', type: 'image/x-icon' }],
  }
}
