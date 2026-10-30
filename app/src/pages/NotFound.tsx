import { Link } from "react-router-dom";
import { Card } from "../components/ui";

export function NotFound() {
  return (
    <div className="page-app narrow">
      <Card title="Page not found">
        <p>
          This page does not exist. Go back to the <Link to="/app">dashboard</Link> or the <Link to="/">home page</Link>.
        </p>
      </Card>
    </div>
  );
}
