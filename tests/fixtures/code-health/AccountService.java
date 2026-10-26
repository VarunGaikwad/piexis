import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AccountService {
  @Transactional
  public void save(Account account) {
    account.validate();
    account.persist();
  }
}
