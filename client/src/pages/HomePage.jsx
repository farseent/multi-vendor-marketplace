import { Link } from 'react-router-dom';

export default function HomePage() {
  return (
    <>
      <h1>Marketplace</h1>
      <p>
        The storefront is under construction. You can already{' '}
        <Link to="/search">search the catalog</Link>.
      </p>
      <p>
        <Link to="/status">Check that the API and its services are running</Link>
      </p>
    </>
  );
}
