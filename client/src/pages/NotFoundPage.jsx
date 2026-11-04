import { Container, LinkButton } from '../components/ui';

export default function NotFoundPage() {
  return (
    <Container narrow className="py-20 text-center sm:py-28">
      <p className="text-sm font-semibold text-brand-600">404</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900 sm:text-4xl">
        Page not found
      </h1>
      <p className="mx-auto mt-3 max-w-md text-slate-600">
        The page you are looking for does not exist or has moved.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <LinkButton to="/">Go to the home page</LinkButton>
        <LinkButton to="/search" variant="secondary">
          Browse products
        </LinkButton>
      </div>
    </Container>
  );
}